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

import {IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IExternal.sol";
import {NATIVE, HopKind, Hop} from "./RouteTypes.sol";

/// @title QuoterStockfill
/// @notice Quotes paths by running the real swaps against the real pools and reverting, so a quote is
///         exactly what the pools would do right now. Not a view: call it with eth_call.
/// @dev    Each hop is quoted against current state. Paths that share a pool cannot be quoted
///         separately and added up, so the routing engine only splits across disjoint paths.
contract QuoterStockfill is IUnlockCallback {
    IUniswapV3Factory public immutable v3Factory;
    IPoolManager public immutable poolManager;
    address public immutable weth;

    error V3Result(int256 amount0, int256 amount1);
    error V4Result(int128 amount0, int128 amount1);
    error NoPool();
    error BadHop(uint256 hop);
    error PartialFill(uint256 hop);
    error NotPoolManager();

    struct V4Quote {
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
    }

    constructor(IUniswapV3Factory _v3Factory, IPoolManager _poolManager, address _weth) {
        v3Factory = _v3Factory;
        poolManager = _poolManager;
        weth = _weth;
    }

    /// @notice Output of selling `amountIn` of `tokenIn` along `hops`. Reverts when a hop cannot fill
    ///         in full, as the router would.
    /// @return amountOut Output of the last hop.
    /// @return hopOut    Output of each hop.
    function quotePath(address tokenIn, Hop[] calldata hops, uint256 amountIn)
        public
        returns (uint256 amountOut, uint256[] memory hopOut)
    {
        _checkPath(tokenIn, hops);
        hopOut = new uint256[](hops.length);
        amountOut = amountIn;
        address current = tokenIn;
        for (uint256 h; h < hops.length; ++h) {
            Hop calldata hop = hops[h];
            if (hop.kind == HopKind.V3) amountOut = _quoteV3(h, current, hop.tokenOut, hop.fee, int256(amountOut));
            else if (hop.kind == HopKind.V4) amountOut = _quoteV4(h, current, hop, int256(amountOut));
            hopOut[h] = amountOut;
            current = hop.tokenOut;
        }
    }

    /// @notice Input needed to buy exactly `amountOut` of the last token of `hops`.
    /// @return amountIn Input of the first hop.
    /// @return hopIn    Input of each hop.
    function quotePathExactOut(address tokenIn, Hop[] calldata hops, uint256 amountOut)
        public
        returns (uint256 amountIn, uint256[] memory hopIn)
    {
        _checkPath(tokenIn, hops);
        hopIn = new uint256[](hops.length);
        amountIn = amountOut;
        for (uint256 h = hops.length; h > 0; --h) {
            Hop calldata hop = hops[h - 1];
            address current = h == 1 ? tokenIn : hops[h - 2].tokenOut;
            if (hop.kind == HopKind.V3) amountIn = _quoteV3(h - 1, current, hop.tokenOut, hop.fee, -int256(amountIn));
            else if (hop.kind == HopKind.V4) amountIn = _quoteV4(h - 1, current, hop, -int256(amountIn));
            hopIn[h - 1] = amountIn;
        }
    }

    /// @notice Quotes many (path, amount) pairs in one call. A quote that fails is 0.
    function quoteMany(address tokenIn, Hop[][] calldata paths, uint256[][] calldata amounts)
        external
        returns (uint256[][] memory outs)
    {
        outs = new uint256[][](paths.length);
        for (uint256 p; p < paths.length; ++p) {
            outs[p] = new uint256[](amounts[p].length);
            for (uint256 a; a < amounts[p].length; ++a) {
                try this.quotePath(tokenIn, paths[p], amounts[p][a]) returns (uint256 out, uint256[] memory) {
                    outs[p][a] = out;
                } catch {}
            }
        }
    }

    /// @notice Exact-output version of `quoteMany`: `amounts` are outputs and the result is inputs.
    function quoteManyExactOut(address tokenIn, Hop[][] calldata paths, uint256[][] calldata amounts)
        external
        returns (uint256[][] memory ins)
    {
        ins = new uint256[][](paths.length);
        for (uint256 p; p < paths.length; ++p) {
            ins[p] = new uint256[](amounts[p].length);
            for (uint256 a; a < amounts[p].length; ++a) {
                try this.quotePathExactOut(tokenIn, paths[p], amounts[p][a]) returns (
                    uint256 amountIn, uint256[] memory
                ) {
                    ins[p][a] = amountIn;
                } catch {}
            }
        }
    }

    function _checkPath(address tokenIn, Hop[] calldata hops) private view {
        address current = tokenIn;
        for (uint256 h; h < hops.length; ++h) {
            HopKind kind = hops[h].kind;
            address next = hops[h].tokenOut;
            bool ok;
            if (kind == HopKind.WRAP) ok = current == NATIVE && next == weth;
            else if (kind == HopKind.UNWRAP) ok = current == weth && next == NATIVE;
            else if (kind == HopKind.V3) ok = current != NATIVE && next != NATIVE && next != current;
            else ok = next != current;
            if (!ok) revert BadHop(h);
            current = next;
        }
    }

    /*//////////////////////////////////////////////////////////////
                                   V3
    //////////////////////////////////////////////////////////////*/

    /// @param amountSpecified Positive for an exact input, negative for an exact output.
    /// @return The other side of the swap: output for exact input, input for exact output.
    function _quoteV3(uint256 h, address tokenIn, address tokenOut, uint24 fee, int256 amountSpecified)
        private
        returns (uint256)
    {
        address pool = v3Factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool();
        bool zeroForOne = tokenIn < tokenOut;
        try IUniswapV3Pool(pool).swap(address(this), zeroForOne, amountSpecified, _priceLimit(zeroForOne), "") {
            revert PartialFill(h);
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != V3Result.selector) _bubble(reason);
            (int256 a0, int256 a1) = _decodePair(reason);
            (int256 paid, int256 received) = zeroForOne ? (a0, -a1) : (a1, -a0);
            return _settled(h, paid, received, amountSpecified);
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external pure {
        revert V3Result(amount0Delta, amount1Delta);
    }

    /*//////////////////////////////////////////////////////////////
                                   V4
    //////////////////////////////////////////////////////////////*/

    /// @param amountSpecified Positive for an exact input, negative for an exact output.
    function _quoteV4(uint256 h, address tokenIn, Hop calldata hop, int256 amountSpecified) private returns (uint256) {
        bool zeroForOne = tokenIn < hop.tokenOut;
        (address c0, address c1) = zeroForOne ? (tokenIn, hop.tokenOut) : (hop.tokenOut, tokenIn);
        V4Quote memory q = V4Quote(
            PoolKey(Currency.wrap(c0), Currency.wrap(c1), hop.fee, hop.tickSpacing, IHooks(hop.hooks)),
            zeroForOne,
            -amountSpecified
        );
        try poolManager.unlock(abi.encode(q)) {
            revert PartialFill(h);
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != V4Result.selector) _bubble(reason);
            (int256 d0, int256 d1) = _decodePair(reason);
            (int256 inDelta, int256 outDelta) = zeroForOne ? (d0, d1) : (d1, d0);
            return _settled(h, -inDelta, outDelta, amountSpecified);
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        V4Quote memory q = abi.decode(data, (V4Quote));
        BalanceDelta delta =
            poolManager.swap(q.key, SwapParams(q.zeroForOne, q.amountSpecified, _priceLimit(q.zeroForOne)), "");
        revert V4Result(delta.amount0(), delta.amount1());
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Checks the specified side filled in full and returns the other side.
    function _settled(uint256 h, int256 paid, int256 received, int256 amountSpecified) private pure returns (uint256) {
        if (paid <= 0 || received <= 0) revert PartialFill(h);
        if (amountSpecified > 0) {
            if (paid != amountSpecified) revert PartialFill(h);
            return uint256(received);
        }
        if (received != -amountSpecified) revert PartialFill(h);
        return uint256(paid);
    }

    function _priceLimit(bool zeroForOne) private pure returns (uint160) {
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    function _decodePair(bytes memory reason) private pure returns (int256 a, int256 b) {
        assembly ("memory-safe") {
            a := mload(add(reason, 36))
            b := mload(add(reason, 68))
        }
    }

    function _bubble(bytes memory reason) private pure {
        assembly ("memory-safe") {
            revert(add(reason, 32), mload(reason))
        }
    }
}
