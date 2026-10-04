// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {
    IERC20Min,
    IERC20Permit,
    ISignatureTransfer,
    IWETH9,
    IUniswapV3Factory,
    IUniswapV3Pool
} from "./interfaces/IExternal.sol";
import {NATIVE, HopKind, Hop, Leg, Trade, Permit, Permit2Transfer} from "./RouteTypes.sol";

/// @title RouterStockfill
/// @notice Executes swaps split across up to ten paths through Uniswap v3 and v4 pools on Robinhood
///         Chain. Routes are computed off-chain.
///         Exact input: spends the whole input and reverts below the minimum output.
///         Exact output: delivers exactly the requested output, reverts above the maximum input and
///         refunds whatever of the maximum was not spent.
///         Input is pulled with an allowance, an EIP-2612 permit or a Permit2 signature.
/// @dev    No owner, fee, pause or upgrade path, and no storage. Nothing is held between calls.
///         v3 pools are looked up in the canonical factory, and only the pool being swapped with can
///         collect in the v3 callback.
contract RouterStockfill is IUnlockCallback {
    uint256 public constant MAX_LEGS = 10;
    uint256 public constant MAX_HOPS = 4;

    IUniswapV3Factory public immutable v3Factory;
    IPoolManager public immutable poolManager;
    address public immutable weth;
    /// @notice Uniswap Permit2, or address(0) on a chain without it.
    ISignatureTransfer public immutable permit2;

    bytes32 private constant LOCK_SLOT = keccak256("stockfill.router.lock");
    bytes32 private constant UNLOCKED_SLOT = keccak256("stockfill.router.unlocked");
    bytes32 private constant V3_POOL_SLOT = keccak256("stockfill.router.v3.pool");
    bytes32 private constant V3_TOKEN_SLOT = keccak256("stockfill.router.v3.token");
    bytes32 private constant V3_AMOUNT_SLOT = keccak256("stockfill.router.v3.amount");
    bytes32 private constant BUDGET_SLOT = keccak256("stockfill.router.budget");
    bytes32 private constant SPENT_SLOT = keccak256("stockfill.router.spent");

    uint256 private constant MAX_AMOUNT = uint256(uint128(type(int128).max));
    bytes1 private constant EXACT_IN = 0x00;
    bytes1 private constant EXACT_OUT = 0x01;

    event Swapped(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 legs
    );

    error Expired();
    error Reentered();
    error BadRoute();
    error BadHop(uint256 leg, uint256 hop);
    error BadValue();
    error BadRecipient();
    error AmountTooLarge();
    error InputNotReceived();
    error OutputNotReceived();
    error NoPool(address tokenA, address tokenB, uint24 fee);
    error PartialFill();
    error UnauthorizedCallback();
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);
    error TooMuchRequested(uint256 amountIn, uint256 maxAmountIn);
    error TransferFailed();
    error UnexpectedETH();
    error Permit2Unavailable();

    struct V4ExactIn {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address tokenIn;
        address tokenOut;
    }

    modifier lock() {
        if (_tload(LOCK_SLOT) != 0) revert Reentered();
        _tstore(LOCK_SLOT, 1);
        _;
        _tstore(LOCK_SLOT, 0);
    }

    constructor(IUniswapV3Factory _v3Factory, IPoolManager _poolManager, address _weth, ISignatureTransfer _permit2) {
        v3Factory = _v3Factory;
        poolManager = _poolManager;
        weth = _weth;
        permit2 = _permit2;
    }

    /// @notice Swaps the summed `amount` of `legs` of `tokenIn` for at least `minAmountOut` of `tokenOut`.
    ///         Use address(0) for native ETH, in which case msg.value must equal the input.
    /// @return amountOut What `recipient` received.
    function swap(
        address tokenIn,
        address tokenOut,
        Leg[] calldata legs,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external payable lock returns (uint256 amountOut) {
        Trade memory t = Trade(tokenIn, tokenOut, false, minAmountOut, recipient, deadline);
        uint256 pull = _prepare(t, legs);
        _pull(tokenIn, pull);
        (, amountOut) = _execute(t, legs, pull);
    }

    /// @notice Swaps at most `maxAmountIn` of `tokenIn` for exactly the summed `amount` of `legs` of
    ///         `tokenOut`. The full `maxAmountIn` is pulled (or sent as msg.value) and the unspent part
    ///         is refunded to the caller.
    /// @return amountIn What the swap cost.
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        Leg[] calldata legs,
        uint256 maxAmountIn,
        address recipient,
        uint256 deadline
    ) external payable lock returns (uint256 amountIn) {
        Trade memory t = Trade(tokenIn, tokenOut, true, maxAmountIn, recipient, deadline);
        uint256 pull = _prepare(t, legs);
        _pull(tokenIn, pull);
        (amountIn,) = _execute(t, legs, pull);
    }

    /// @notice `swap` or `swapExactOut` for a token that supports EIP-2612, approving the router with
    ///         `permit` in the same transaction. A permit that was already used still works as long
    ///         as the allowance it granted is in place.
    function swapWithPermit(Trade calldata t, Leg[] calldata legs, Permit calldata permit)
        external
        lock
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (t.tokenIn == NATIVE) revert BadValue();
        uint256 pull = _prepare(t, legs);
        try IERC20Permit(t.tokenIn)
            .permit(msg.sender, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s) {}
            catch {}
        _pull(t.tokenIn, pull);
        return _execute(t, legs, pull);
    }

    /// @notice `swap` or `swapExactOut` paid through a Permit2 signature transfer signed by the caller.
    function swapWithPermit2(Trade calldata t, Leg[] calldata legs, Permit2Transfer calldata permit)
        external
        lock
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (address(permit2) == address(0)) revert Permit2Unavailable();
        if (t.tokenIn == NATIVE) revert BadValue();
        uint256 pull = _prepare(t, legs);
        uint256 before = _balance(t.tokenIn);
        permit2.permitTransferFrom(
            ISignatureTransfer.PermitTransferFrom(
                ISignatureTransfer.TokenPermissions(t.tokenIn, permit.amount), permit.nonce, permit.deadline
            ),
            ISignatureTransfer.SignatureTransferDetails(address(this), pull),
            msg.sender,
            permit.signature
        );
        if (_balance(t.tokenIn) - before != pull) revert InputNotReceived();
        return _execute(t, legs, pull);
    }

    /*//////////////////////////////////////////////////////////////
                               EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @return pull What to collect from the caller: the summed input, or the maximum input.
    function _prepare(Trade memory t, Leg[] calldata legs) private view returns (uint256 pull) {
        if (block.timestamp > t.deadline) revert Expired();
        // Output sent to the router itself would be stranded there.
        if (t.recipient == address(0) || t.recipient == address(this)) revert BadRecipient();
        if (t.tokenIn == t.tokenOut || legs.length == 0 || legs.length > MAX_LEGS) revert BadRoute();

        uint256 total;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].amount == 0) revert BadRoute();
            total += legs[i].amount;
            _checkPath(i, t.tokenIn, t.tokenOut, legs[i].hops);
        }
        pull = t.exactOut ? t.amountLimit : total;
        if (total > MAX_AMOUNT || pull > MAX_AMOUNT) revert AmountTooLarge();
    }

    function _checkPath(uint256 leg, address tokenIn, address tokenOut, Hop[] calldata hops) private view {
        uint256 n = hops.length;
        if (n == 0 || n > MAX_HOPS) revert BadRoute();
        address current = tokenIn;
        for (uint256 h; h < n; ++h) {
            HopKind kind = hops[h].kind;
            address next = hops[h].tokenOut;
            bool ok;
            if (kind == HopKind.WRAP) ok = current == NATIVE && next == weth;
            else if (kind == HopKind.UNWRAP) ok = current == weth && next == NATIVE;
            else if (kind == HopKind.V3) ok = current != NATIVE && next != NATIVE && next != current;
            else ok = next != current;
            if (!ok) revert BadHop(leg, h);
            current = next;
        }
        if (current != tokenOut) revert BadRoute();
    }

    function _pull(address token, uint256 amount) private {
        if (token == NATIVE) {
            if (msg.value != amount) revert BadValue();
            return;
        }
        if (msg.value != 0) revert BadValue();
        uint256 before = _balance(token);
        _safeTransferFrom(token, msg.sender, address(this), amount);
        if (_balance(token) - before != amount) revert InputNotReceived();
    }

    function _execute(Trade memory t, Leg[] calldata legs, uint256 pulled)
        private
        returns (uint256 amountIn, uint256 amountOut)
    {
        uint256 inStart = _selfBalance(t.tokenIn);
        uint256 outStart = _selfBalance(t.tokenOut);

        if (t.exactOut) {
            _tstore(BUDGET_SLOT, t.amountLimit);
            for (uint256 i; i < legs.length; ++i) {
                Hop[] memory hops = legs[i].hops;
                _obtain(t.tokenIn, hops, hops.length, legs[i].amount);
                amountOut += legs[i].amount;
            }
            amountIn = inStart - _selfBalance(t.tokenIn);
            if (amountIn > t.amountLimit) revert TooMuchRequested(amountIn, t.amountLimit);
            _tstore(BUDGET_SLOT, 0);
            _tstore(SPENT_SLOT, 0);
        } else {
            for (uint256 i; i < legs.length; ++i) {
                amountOut += _legExactIn(t.tokenIn, legs[i]);
            }
            amountIn = pulled;
            if (amountOut < t.amountLimit) revert TooLittleReceived(amountOut, t.amountLimit);
        }

        // Pools report amounts; the balance has to agree (catches tokens that tax transfers).
        if (_selfBalance(t.tokenOut) < outStart + amountOut) revert OutputNotReceived();

        _send(t.tokenOut, t.recipient, amountOut);
        if (pulled > amountIn) _send(t.tokenIn, msg.sender, pulled - amountIn);
        emit Swapped(msg.sender, t.recipient, t.tokenIn, t.tokenOut, amountIn, amountOut, legs.length);
    }

    /*//////////////////////////////////////////////////////////////
                              EXACT INPUT
    //////////////////////////////////////////////////////////////*/

    function _legExactIn(address tokenIn, Leg calldata leg) private returns (uint256 amount) {
        amount = leg.amount;
        address current = tokenIn;
        for (uint256 h; h < leg.hops.length; ++h) {
            Hop calldata hop = leg.hops[h];
            if (hop.kind == HopKind.WRAP) {
                IWETH9(weth).deposit{value: amount}();
            } else if (hop.kind == HopKind.UNWRAP) {
                IWETH9(weth).withdraw(amount);
            } else if (hop.kind == HopKind.V3) {
                amount = _v3ExactIn(current, hop.tokenOut, hop.fee, amount);
            } else {
                amount = _v4ExactIn(current, hop, amount);
            }
            if (amount == 0) revert PartialFill();
            current = hop.tokenOut;
        }
    }

    function _v3ExactIn(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) private returns (uint256) {
        address pool = _v3Pool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn < tokenOut;

        _tstore(V3_POOL_SLOT, uint256(uint160(pool)));
        _tstore(V3_TOKEN_SLOT, uint256(uint160(tokenIn)));
        _tstore(V3_AMOUNT_SLOT, amountIn);
        (int256 amount0, int256 amount1) =
            IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(amountIn), _priceLimit(zeroForOne), "");
        if (_tload(V3_POOL_SLOT) != 0) revert PartialFill();
        _tstore(V3_TOKEN_SLOT, 0);
        _tstore(V3_AMOUNT_SLOT, 0);

        (int256 paid, int256 received) = zeroForOne ? (amount0, -amount1) : (amount1, -amount0);
        if (paid != int256(amountIn) || received <= 0) revert PartialFill();
        return uint256(received);
    }

    function _v4ExactIn(address tokenIn, Hop calldata hop, uint256 amountIn) private returns (uint256) {
        (PoolKey memory key, bool zeroForOne) = _poolKey(tokenIn, hop.tokenOut, hop.fee, hop.tickSpacing, hop.hooks);
        V4ExactIn memory s = V4ExactIn(key, zeroForOne, amountIn, tokenIn, hop.tokenOut);
        return abi.decode(poolManager.unlock(bytes.concat(EXACT_IN, abi.encode(s))), (uint256));
    }

    function _v4ExactInUnlocked(V4ExactIn memory s) private returns (uint256 out) {
        BalanceDelta delta =
            poolManager.swap(s.key, SwapParams(s.zeroForOne, -int256(s.amountIn), _priceLimit(s.zeroForOne)), "");
        (int128 inDelta, int128 outDelta) =
            s.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (int256(inDelta) != -int256(s.amountIn) || outDelta <= 0) revert PartialFill();

        _settle(s.tokenIn, s.amountIn);
        out = uint256(uint128(outDelta));
        poolManager.take(Currency.wrap(s.tokenOut), address(this), out);
    }

    /*//////////////////////////////////////////////////////////////
                              EXACT OUTPUT
    //////////////////////////////////////////////////////////////*/

    /// @dev Leaves exactly `amount` of the token delivered by hops[n - 1] on this contract by running
    ///      hops[0..n-1] backwards as exact-output swaps. Each hop is paid for by the one before it;
    ///      the first is paid from the input already held here, within the caller's maximum.
    function _obtain(address tokenIn, Hop[] memory hops, uint256 n, uint256 amount) private {
        if (n == 0) {
            uint256 spent = _tload(SPENT_SLOT) + amount;
            uint256 budget = _tload(BUDGET_SLOT);
            if (spent > budget) revert TooMuchRequested(spent, budget);
            _tstore(SPENT_SLOT, spent);
            return;
        }
        Hop memory hop = hops[n - 1];
        if (hop.kind == HopKind.WRAP) {
            _obtain(tokenIn, hops, n - 1, amount);
            IWETH9(weth).deposit{value: amount}();
        } else if (hop.kind == HopKind.UNWRAP) {
            _obtain(tokenIn, hops, n - 1, amount);
            IWETH9(weth).withdraw(amount);
        } else if (hop.kind == HopKind.V3) {
            _v3ExactOut(tokenIn, hops, n, amount);
        } else if (_tload(UNLOCKED_SLOT) != 0) {
            _v4ExactOutUnlocked(tokenIn, hops, n, amount);
        } else {
            poolManager.unlock(bytes.concat(EXACT_OUT, abi.encode(tokenIn, hops, n, amount)));
        }
    }

    function _v3ExactOut(address tokenIn, Hop[] memory hops, uint256 n, uint256 amountOut) private {
        Hop memory hop = hops[n - 1];
        address hopIn = n == 1 ? tokenIn : hops[n - 2].tokenOut;
        address pool = _v3Pool(hopIn, hop.tokenOut, hop.fee);
        bool zeroForOne = hopIn < hop.tokenOut;

        _tstore(V3_POOL_SLOT, uint256(uint160(pool)));
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool)
            .swap(
                address(this), zeroForOne, -int256(amountOut), _priceLimit(zeroForOne), abi.encode(tokenIn, hops, n - 1)
            );
        if (_tload(V3_POOL_SLOT) != 0) revert PartialFill();
        if ((zeroForOne ? -amount1 : -amount0) != int256(amountOut)) revert PartialFill();
    }

    function _v4ExactOutUnlocked(address tokenIn, Hop[] memory hops, uint256 n, uint256 amountOut) private {
        Hop memory hop = hops[n - 1];
        address hopIn = n == 1 ? tokenIn : hops[n - 2].tokenOut;
        (PoolKey memory key, bool zeroForOne) = _poolKey(hopIn, hop.tokenOut, hop.fee, hop.tickSpacing, hop.hooks);

        BalanceDelta delta =
            poolManager.swap(key, SwapParams(zeroForOne, int256(amountOut), _priceLimit(zeroForOne)), "");
        (int128 inDelta, int128 outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (int256(outDelta) != int256(amountOut) || inDelta >= 0) revert PartialFill();

        uint256 owed = uint256(-int256(inDelta));
        _obtain(tokenIn, hops, n - 1, owed);
        _settle(hopIn, owed);
        poolManager.take(Currency.wrap(hop.tokenOut), address(this), amountOut);
    }

    /*//////////////////////////////////////////////////////////////
                               CALLBACKS
    //////////////////////////////////////////////////////////////*/

    /// @dev Only the pool being swapped with can collect. Exact-input hops pay exactly the amount the
    ///      hop was sized for; exact-output hops first obtain what the pool asks for from the hops
    ///      before them.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = address(uint160(_tload(V3_POOL_SLOT)));
        if (pool == address(0) || msg.sender != pool) revert UnauthorizedCallback();
        _tstore(V3_POOL_SLOT, 0);

        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        if (data.length == 0) {
            if (owed != _tload(V3_AMOUNT_SLOT)) revert PartialFill();
            _safeTransfer(address(uint160(_tload(V3_TOKEN_SLOT))), pool, owed);
        } else {
            (address tokenIn, Hop[] memory hops, uint256 n) = abi.decode(data, (address, Hop[], uint256));
            _obtain(tokenIn, hops, n, owed);
            _safeTransfer(n == 0 ? tokenIn : hops[n - 1].tokenOut, pool, owed);
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != address(poolManager) || _tload(LOCK_SLOT) == 0) revert UnauthorizedCallback();
        _tstore(UNLOCKED_SLOT, 1);
        if (data[0] == EXACT_IN) {
            result = abi.encode(_v4ExactInUnlocked(abi.decode(data[1:], (V4ExactIn))));
        } else {
            (address tokenIn, Hop[] memory hops, uint256 n, uint256 amount) =
                abi.decode(data[1:], (address, Hop[], uint256, uint256));
            _v4ExactOutUnlocked(tokenIn, hops, n, amount);
        }
        _tstore(UNLOCKED_SLOT, 0);
    }

    /// @dev ETH only arrives mid-swap, from WETH or the PoolManager.
    receive() external payable {
        if (msg.sender != weth && msg.sender != address(poolManager)) revert UnexpectedETH();
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _v3Pool(address tokenA, address tokenB, uint24 fee) private view returns (address pool) {
        pool = v3Factory.getPool(tokenA, tokenB, fee);
        if (pool == address(0)) revert NoPool(tokenA, tokenB, fee);
    }

    function _poolKey(address tokenIn, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)
        private
        pure
        returns (PoolKey memory key, bool zeroForOne)
    {
        zeroForOne = tokenIn < tokenOut;
        (address c0, address c1) = zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, tickSpacing, IHooks(hooks));
    }

    function _priceLimit(bool zeroForOne) private pure returns (uint160) {
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _settle(address token, uint256 amount) private {
        if (token == NATIVE) {
            // A hook may leave another currency synced, and a native settle against it reverts.
            poolManager.sync(Currency.wrap(NATIVE));
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(Currency.wrap(token));
            _safeTransfer(token, address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
    }

    function _selfBalance(address token) private view returns (uint256) {
        return token == NATIVE ? address(this).balance : _balance(token);
    }

    function _balance(address token) private view returns (uint256) {
        return IERC20Min(token).balanceOf(address(this));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        _checkTransfer(token, ok, ret);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Min.transferFrom, (from, to, amount)));
        _checkTransfer(token, ok, ret);
    }

    /// @dev Bubbles the token's own revert data so wallets show the real reason.
    function _checkTransfer(address token, bool ok, bytes memory ret) private view {
        if (!ok) {
            if (ret.length > 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert TransferFailed();
        }
        if ((ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }

    function _tstore(bytes32 slot, uint256 value) private {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
