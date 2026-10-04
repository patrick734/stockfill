// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdError} from "forge-std/StdError.sol";
import {console2} from "forge-std/console2.sol";
import {Venues, WETH9, IV3PoolFull} from "./Base.t.sol";
import {RouterStockfill} from "../src/RouterStockfill.sol";
import {QuoterStockfill} from "../src/QuoterStockfill.sol";
import {NATIVE, HopKind, Hop, Leg, Trade, Permit, Permit2Transfer} from "../src/RouteTypes.sol";
import {ISignatureTransfer, IUniswapV3Pool} from "../src/interfaces/IExternal.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {BaseTestHooks} from "v4-core/test/BaseTestHooks.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/*//////////////////////////////////////////////////////////////
                               MOCKS
//////////////////////////////////////////////////////////////*/

/// v4 hook that can:
/// - probe the router from `beforeSwap` (re-entry, forged callbacks, a second unlock);
/// - take an extra `greed` on the unspecified side, optionally only from `greedOnlyFor` so the
///   quoter does not see it;
/// - leave `syncToken` synced on the PoolManager.
contract AdvHook is BaseTestHooks {
    IPoolManager immutable manager;
    RouterStockfill immutable router;

    int128 public greed;
    address public greedOnlyFor;
    address public syncToken;
    bool public probe;

    uint256 public probeSuccesses;
    bytes4[] public probeErrors;

    constructor(IPoolManager m, RouterStockfill r) {
        manager = m;
        router = r;
    }

    function configure(int128 g, address only, address s, bool p) external {
        greed = g;
        greedOnlyFor = only;
        syncToken = s;
        probe = p;
    }

    function probeErrorCount() external view returns (uint256) {
        return probeErrors.length;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (probe) _probe();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        int128 g = greed;
        if (greedOnlyFor != address(0) && sender != greedOnlyFor) g = 0;
        if (g > 0) {
            Currency unspecified = (params.zeroForOne == (params.amountSpecified < 0)) ? key.currency1 : key.currency0;
            manager.take(unspecified, address(this), uint256(uint128(g)));
        }
        if (syncToken != address(0)) manager.sync(Currency.wrap(syncToken));
        return (IHooks.afterSwap.selector, g);
    }

    function _probe() internal {
        Hop[] memory hops = new Hop[](1);
        hops[0] = Hop(HopKind.V3, address(0xdead), 500, 0, address(0));
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(1, hops);
        try router.swap(address(0xbeef), address(0xdead), legs, 0, address(this), type(uint256).max) {
            probeSuccesses++;
        } catch (bytes memory r) {
            probeErrors.push(bytes4(r));
        }
        try router.swapExactOut(address(0xbeef), address(0xdead), legs, 1, address(this), type(uint256).max) {
            probeSuccesses++;
        } catch (bytes memory r) {
            probeErrors.push(bytes4(r));
        }
        try router.unlockCallback(
            bytes.concat(bytes1(0x01), abi.encode(address(0xbeef), hops, uint256(0), uint256(1e18)))
        ) {
            probeSuccesses++;
        } catch (bytes memory r) {
            probeErrors.push(bytes4(r));
        }
        try router.uniswapV3SwapCallback(1e18, 0, "") {
            probeSuccesses++;
        } catch (bytes memory r) {
            probeErrors.push(bytes4(r));
        }
        try router.uniswapV3SwapCallback(1e18, 0, abi.encode(address(0xbeef), hops, uint256(0))) {
            probeSuccesses++;
        } catch (bytes memory r) {
            probeErrors.push(bytes4(r));
        }
        try manager.unlock("") {
            probeSuccesses++;
        } catch (bytes memory r) {
            probeErrors.push(bytes4(r));
        }
    }

    receive() external payable {}
}

/// ERC20 that, while a v3 pool transfers it to the router (when the router's v3 pool slot is set),
/// calls the router's v3 callback, re-enters the router and re-enters the pool.
contract ProbeToken is MockERC20 {
    RouterStockfill immutable router;
    bool public armed;
    uint256 public successes;
    uint256 public attempts;

    constructor(RouterStockfill r) MockERC20("Probe", "PRB", 18) {
        router = r;
    }

    function arm(bool a) external {
        armed = a;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed && to == address(router)) {
            armed = false; // probe once, avoid recursion
            attempts += 3;
            // Router v3 callback from a non-pool address.
            try router.uniswapV3SwapCallback(int256(1e24), int256(1e24), "") {
                successes++;
            } catch {}
            // Router re-entry.
            Hop[] memory hops = new Hop[](1);
            hops[0] = Hop(HopKind.V3, address(this), 500, 0, address(0));
            Leg[] memory legs = new Leg[](1);
            legs[0] = Leg(1, hops);
            try router.swap(address(0xbeef), address(this), legs, 0, address(this), type(uint256).max) {
                successes++;
            } catch {}
            // Pool re-entry, which would call the router's callback again.
            try IUniswapV3Pool(msg.sender).swap(address(this), true, 1e6, 4295128740, "") {
                successes++;
            } catch {}
            armed = true;
        }
        return super.transfer(to, amount);
    }
}

/// Token whose transfers can be switched to charge 1%, so pools can be seeded first.
contract ToggleTaxToken is MockERC20 {
    bool public taxed;

    constructor() MockERC20("ToggleTax", "TTAX", 18) {}

    function setTaxed(bool t) external {
        taxed = t;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (!taxed) return super.transfer(to, amount);
        balanceOf[msg.sender] -= amount;
        unchecked {
            balanceOf[to] += amount - amount / 100;
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (!taxed) return super.transferFrom(from, to, amount);
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount - amount / 100;
        }
        return true;
    }
}

/// Token whose `transfer` reverts with data shaped like the quoter's V3Result error.
contract SpoofToken is MockERC20 {
    bool public spoof;

    constructor() MockERC20("Spoof", "SPF", 18) {}

    function setSpoof(bool s) external {
        spoof = s;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (spoof) {
            bytes memory fake = abi.encodeWithSelector(QuoterStockfill.V3Result.selector, int256(1), -int256(1e30));
            assembly {
                revert(add(fake, 32), mload(fake))
            }
        }
        return super.transfer(to, amount);
    }
}

/// Contract caller that can call the router several times in one transaction.
contract Caller {
    function approve(address token, address spender) external {
        MockERC20(token).approve(spender, type(uint256).max);
    }

    function exec(address target, bytes calldata data, uint256 value)
        external
        payable
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = target.call{value: value}(data);
    }

    receive() external payable {}
}

/// Contract without `receive`, so ETH refunds to it fail.
contract NoEthCaller {
    function buy(RouterStockfill r, address tokenOut, Leg[] calldata legs, uint256 maxIn) external payable {
        r.swapExactOut{value: maxIn}(NATIVE, tokenOut, legs, maxIn, msg.sender, block.timestamp);
    }
}

/// Holds the PoolManager unlocked and calls the router from inside.
contract Unlocker is IUnlockCallback {
    IPoolManager immutable manager;
    address immutable router;
    bytes pending;
    bool public lastOk;
    bytes public lastRet;

    constructor(IPoolManager m, address r) {
        manager = m;
        router = r;
    }

    function approve(address token) external {
        MockERC20(token).approve(router, type(uint256).max);
    }

    function run(bytes calldata routerCall) external {
        pending = routerCall;
        manager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        (lastOk, lastRet) = router.call(pending);
        return "";
    }
}

/// Etched over the router to read its transient storage in the same transaction.
contract TransientReader {
    function read(bytes32[] calldata slots) external view returns (uint256[] memory v) {
        v = new uint256[](slots.length);
        for (uint256 i; i < slots.length; ++i) {
            bytes32 s = slots[i];
            uint256 x;
            assembly {
                x := tload(s)
            }
            v[i] = x;
        }
    }

    function write(bytes32 s, uint256 x) external {
        assembly {
            tstore(s, x)
        }
    }
}

/// Mirrors Hop/Leg with a raw uint8 kind, to send out-of-range enum values.
struct RawHop {
    uint8 kind;
    address tokenOut;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct RawLeg {
    uint256 amount;
    RawHop[] hops;
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/*//////////////////////////////////////////////////////////////
                              TESTS
//////////////////////////////////////////////////////////////*/

contract RouterStockfillAdversarialTest is Venues {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    uint256 constant MAX_AMOUNT = uint256(uint128(type(int128).max));

    address attacker = makeAddr("attacker");

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _deployHook(uint256 salt) internal returns (AdvHook h) {
        uint160 flags = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        address a = address((uint160(uint256(keccak256(abi.encode("adv-hook", salt)))) & ~Hooks.ALL_HOOK_MASK) | flags);
        vm.etch(a, address(new AdvHook(manager, router)).code);
        h = AdvHook(payable(a));
    }

    function _slots() internal pure returns (bytes32[] memory s) {
        s = new bytes32[](7);
        s[0] = keccak256("stockfill.router.lock");
        s[1] = keccak256("stockfill.router.unlocked");
        s[2] = keccak256("stockfill.router.v3.pool");
        s[3] = keccak256("stockfill.router.v3.token");
        s[4] = keccak256("stockfill.router.v3.amount");
        s[5] = keccak256("stockfill.router.budget");
        s[6] = keccak256("stockfill.router.spent");
    }

    /// Reads the router's transient storage without leaving the transaction.
    function _routerTransient() internal returns (uint256[] memory v) {
        bytes memory code = address(router).code;
        vm.etch(address(router), type(TransientReader).runtimeCode);
        v = TransientReader(address(router)).read(_slots());
        vm.etch(address(router), code);
    }

    function _assertTransientClear(string memory where) internal {
        uint256[] memory v = _routerTransient();
        for (uint256 i; i < v.length; ++i) {
            assertEq(v[i], 0, string.concat("transient slot left set after ", where));
        }
    }

    function _path4(Hop memory a, Hop memory b, Hop memory c, Hop memory d) internal pure returns (Hop[] memory p) {
        p = new Hop[](4);
        p[0] = a;
        p[1] = b;
        p[2] = c;
        p[3] = d;
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return token == NATIVE ? who.balance : MockERC20(token).balanceOf(who);
    }

    function _permit(address owner, uint256 key, uint256 value, uint256 deadline)
        internal
        view
        returns (Permit memory p)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(router), value, usdg.nonces(owner), deadline));
        (p.v, p.r, p.s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
        p.value = value;
        p.deadline = deadline;
    }

    function _permit2Sig(uint256 key, address token, address spender, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (Permit2Transfer memory p)
    {
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissions, spender, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(permit2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        p = Permit2Transfer(amount, nonce, deadline, abi.encodePacked(r, s, v));
    }

    /*//////////////////////////////////////////////////////////////
                     CALLBACKS AND TRANSIENT STATE
    //////////////////////////////////////////////////////////////*/

    /// The etched reader sees the router's transient storage.
    function test_transientReader_readsRouterSlots() public {
        bytes memory code = address(router).code;
        vm.etch(address(router), type(TransientReader).runtimeCode);
        TransientReader(address(router)).write(keccak256("stockfill.router.budget"), 42);
        vm.etch(address(router), code);
        assertEq(_routerTransient()[5], 42);
        vm.etch(address(router), type(TransientReader).runtimeCode);
        TransientReader(address(router)).write(keccak256("stockfill.router.budget"), 0);
        vm.etch(address(router), code);
        _assertTransientClear("sanity reset");
    }

    /// No transient slot survives into the rest of the transaction, across entry points, hop kinds,
    /// nested exact output and a caught revert.
    function test_transient_allSlotsClearAfterEveryEntryPoint() public {
        // exact in: v3 -> v3 -> v4
        Hop[] memory p1 =
            _path(_hopV3(address(nvda), 500), _hopV3(address(tsla), 3000), _hopV4(address(meme), 3000, 60, address(0)));
        _swap(address(usdg), address(meme), _legs(1_000e6, p1), 0);
        _assertTransientClear("exact in v3-v3-v4");

        // exact out: v4 -> v3 -> v4 (v4 reached from inside a v3 callback inside an unlock)
        Hop[] memory p2 = _path(
            _hopV4(address(nvda), 3000, 60, address(0)),
            _hopV3(address(tsla), 3000),
            _hopV4(address(meme), 3000, 60, address(0))
        );
        uint256 q = _quoteOut(address(usdg), p2, 1e9);
        _swapExactOut(address(usdg), address(meme), _legs(1e9, p2), q * 2);
        _assertTransientClear("exact out v4-v3-v4");

        // exact out with native input, wrap and v3
        Hop[] memory p3 = _path(_hopWrap(address(weth)), _hopV3(address(meme), 10000));
        q = _quoteOut(NATIVE, p3, 1e18);
        _swapExactOutETH(address(meme), _legs(1e18, p3), q + 1 ether);
        _assertTransientClear("exact out ETH");

        // a contract catches an exact-out revert (budget exceeded inside the recursion), then swaps
        // twice more in the same transaction
        Caller c = new Caller();
        usdg.mint(address(c), 1e30);
        c.approve(address(usdg), address(router));
        q = _quoteOut(address(usdg), p2, 1e9);
        (bool ok, bytes memory ret) = c.exec(
            address(router),
            abi.encodeCall(
                router.swapExactOut, (address(usdg), address(meme), _legs(1e9, p2), q - 1, address(c), block.timestamp)
            ),
            0
        );
        assertFalse(ok);
        assertEq(bytes4(ret), RouterStockfill.TooMuchRequested.selector);
        _assertTransientClear("caught revert");
        (ok,) = c.exec(
            address(router),
            abi.encodeCall(
                router.swapExactOut, (address(usdg), address(meme), _legs(1e9, p2), q * 2, address(c), block.timestamp)
            ),
            0
        );
        assertTrue(ok);
        (ok,) = c.exec(
            address(router),
            abi.encodeCall(router.swap, (address(usdg), address(meme), _legs(1e9, p1), 0, address(c), block.timestamp)),
            0
        );
        assertTrue(ok, "second call in the same tx");
        _assertTransientClear("two calls from one contract in one tx");

        // the callbacks stay closed for the rest of the transaction
        deal(address(usdg), address(router), 1e12);
        address pool = v3.getPool(address(usdg), address(nvda), 500);
        vm.prank(pool);
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.uniswapV3SwapCallback(1e12, 0, "");
        vm.prank(pool);
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.uniswapV3SwapCallback(1e12, 0, abi.encode(address(usdg), new Hop[](0), uint256(0)));
        vm.prank(address(manager));
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.unlockCallback(bytes.concat(bytes1(0x00), new bytes(32)));
    }

    /// A hook in the route cannot re-enter the router, call its callbacks or open a second unlock,
    /// on exact input or nested exact output.
    function test_hook_cannotReenterOrForgeCallbacks() public {
        AdvHook h = _deployHook(1);
        _v4Pool(address(usdg), address(tsla), 3000, 60, address(h), PRICE_1_1, DEEP4);
        deal(address(usdg), address(router), 5e12);

        // exact in, single hooked hop
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, address(h)));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        h.configure(0, address(0), address(0), true);
        assertEq(_swap(address(usdg), address(tsla), _legs(1_000e6, p), q), q);
        _checkProbe(h, 6);

        // exact out, hooked v4 hop reached from inside a v3 callback (v3 pool locked mid-swap)
        h.configure(0, address(0), address(0), false);
        Hop[] memory p2 = _path(_hopV4(address(tsla), 3000, 60, address(h)), _hopV3(address(nvda), 3000));
        uint256 qo = _quoteOut(address(usdg), p2, 1e9);
        h.configure(0, address(0), address(0), true);
        uint256 spent = _swapExactOut(address(usdg), address(nvda), _legs(1e9, p2), qo * 2);
        assertEq(spent, qo);
        _checkProbe(h, 12);
        assertEq(usdg.balanceOf(address(router)), 5e12, "donation untouched");
    }

    function _checkProbe(AdvHook h, uint256 expectedErrors) internal view {
        assertEq(h.probeSuccesses(), 0, "a probe succeeded");
        assertEq(h.probeErrorCount(), expectedErrors);
        uint256 base = expectedErrors - 6;
        assertEq(h.probeErrors(base + 0), RouterStockfill.Reentered.selector);
        assertEq(h.probeErrors(base + 1), RouterStockfill.Reentered.selector);
        assertEq(h.probeErrors(base + 2), RouterStockfill.UnauthorizedCallback.selector);
        assertEq(h.probeErrors(base + 3), RouterStockfill.UnauthorizedCallback.selector);
        assertEq(h.probeErrors(base + 4), RouterStockfill.UnauthorizedCallback.selector);
        assertEq(h.probeErrors(base + 5), IPoolManager.AlreadyUnlocked.selector);
    }

    /// While a v3 pool transfers output to the router, the token cannot collect through the callback,
    /// re-enter the router or re-enter the pool.
    function test_v3Callback_tokenCannotForgeMidSwap() public {
        ProbeToken prb = new ProbeToken(router);
        prb.mint(address(this), 1e40);
        prb.approve(address(lp3), type(uint256).max);
        _v3Pool(address(usdg), address(prb), 500, PRICE_1_1, DEEP);
        deal(address(usdg), address(router), 5e12);
        prb.mint(address(router), 5e24);
        prb.arm(true);

        Hop[] memory p = _path(_hopV3(address(prb), 500));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        assertEq(_swap(address(usdg), address(prb), _legs(1_000e6, p), q), q);
        assertEq(prb.attempts(), 3);
        assertEq(prb.successes(), 0);

        prb.arm(false);
        uint256 qo = _quoteOut(address(usdg), p, 1e9);
        prb.arm(true);
        assertEq(_swapExactOut(address(usdg), address(prb), _legs(1e9, p), qo * 2), qo);
        assertEq(prb.attempts(), 6);
        assertEq(prb.successes(), 0);
        assertEq(usdg.balanceOf(address(router)), 5e12);
        assertEq(prb.balanceOf(address(router)), 5e24);
    }

    /*//////////////////////////////////////////////////////////////
                              V4 HOOK DELTAS
    //////////////////////////////////////////////////////////////*/

    /// A hook charging extra input on exact output, hidden from the quoter, is bounded by the
    /// maximum input: one wei more reverts.
    function test_hook_greedyExactOut_boundedByMaxIn() public {
        AdvHook h = _deployHook(2);
        _v4Pool(address(usdg), address(tsla), 3000, 60, address(h), PRICE_1_1, DEEP4);
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, address(h)));
        uint256 out = 1_000e6;
        uint256 q = _quoteOut(address(usdg), p, out);
        uint256 maxIn = q * 10050 / 10000;

        h.configure(int128(int256(maxIn - q + 1)), address(router), address(0), false);
        assertEq(_quoteOut(address(usdg), p, out), q, "hook hides from the quoter");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, maxIn + 1, maxIn));
        router.swapExactOut(address(usdg), address(tsla), _legs(out, p), maxIn, user, block.timestamp);

        h.configure(int128(int256(maxIn - q)), address(router), address(0), false);
        uint256 before = usdg.balanceOf(user);
        uint256 tslaBefore = tsla.balanceOf(user);
        assertEq(_swapExactOut(address(usdg), address(tsla), _legs(out, p), maxIn), maxIn);
        assertEq(before - usdg.balanceOf(user), maxIn, "loss is capped at maxAmountIn");
        assertEq(tsla.balanceOf(user) - tslaBefore, out, "exact output still delivered");
        _assertRouterEmpty();
    }

    /// The exact-output budget is shared across legs: each leg fits under the maximum alone, the sum
    /// does not.
    function test_exactOut_budgetSharedAcrossLegs() public {
        Leg[] memory legs = new Leg[](2);
        legs[0] = Leg(1e9, _path(_hopV3(address(nvda), 500)));
        legs[1] = Leg(1e9, _path(_hopV4(address(nvda), 3000, 60, address(0))));
        uint256 qa = _quoteOut(address(usdg), legs[0].hops, 1e9);
        uint256 qb = _quoteOut(address(usdg), legs[1].hops, 1e9);
        uint256 maxIn = qa + qb - 1;
        assertGt(maxIn, qa);
        assertGt(maxIn, qb);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, qa + qb, maxIn));
        router.swapExactOut(address(usdg), address(nvda), legs, maxIn, user, block.timestamp);
        assertEq(_swapExactOut(address(usdg), address(nvda), legs, maxIn + 1), qa + qb);
        _assertRouterEmpty();
    }

    /// A fee-taking hook on the first hop of a nested exact-output route is stopped by the budget
    /// check before anything is paid.
    function test_hook_greedyExactOut_nested_boundedByBudget() public {
        AdvHook h = _deployHook(3);
        _v4Pool(address(usdg), address(tsla), 3000, 60, address(h), PRICE_1_1, DEEP4);
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, address(h)), _hopV3(address(nvda), 3000));
        uint256 q = _quoteOut(address(usdg), p, 1e9);
        h.configure(int128(int256(q)), address(router), address(0), false); // doubles the cost
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, 2 * q, q * 3 / 2));
        router.swapExactOut(address(usdg), address(nvda), _legs(1e9, p), q * 3 / 2, user, block.timestamp);
    }

    /// A hook taking output on exact input is bounded by `minAmountOut`; taking more than the whole
    /// output is a PartialFill.
    function test_hook_greedyExactIn_boundedByMinOut() public {
        AdvHook h = _deployHook(4);
        _v4Pool(address(usdg), address(tsla), 3000, 60, address(h), PRICE_1_1, DEEP4);
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, address(h)));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        uint256 minOut = q * 9950 / 10000;

        h.configure(int128(int256(q - minOut + 1)), address(router), address(0), false);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooLittleReceived.selector, minOut - 1, minOut));
        router.swap(address(usdg), address(tsla), _legs(1_000e6, p), minOut, user, block.timestamp);

        h.configure(int128(int256(q + 1)), address(router), address(0), false);
        vm.prank(user);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swap(address(usdg), address(tsla), _legs(1_000e6, p), 0, user, block.timestamp);

        h.configure(int128(int256(q - minOut)), address(router), address(0), false);
        assertEq(_swap(address(usdg), address(tsla), _legs(1_000e6, p), minOut), minOut);
        _assertRouterEmpty();
    }

    /// A hook that leaves an ERC20 synced on the PoolManager cannot block native ETH settlement.
    function test_hookLeavingSyncedCurrency_nativeSettleStillWorks() public {
        AdvHook h = _deployHook(5);
        _v4Pool(NATIVE, address(meme), 3000, 60, address(h), PRICE_1_1, 1e21);
        h.configure(0, address(0), address(usdg), false);

        Hop[] memory buy = _path(_hopV4(address(meme), 3000, 60, address(h)));
        assertGt(_swapETH(address(meme), _legs(1 ether, buy), 1 ether, 0), 0);

        Hop[] memory sell = _path(_hopV4(NATIVE, 3000, 60, address(h)));
        assertGt(_swap(address(meme), NATIVE, _legs(1 ether, sell), 0), 0);
        _assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                            PATH VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _rawSwap(uint8 kind, bool exactOut) internal returns (bool ok, bytes memory ret) {
        RawHop[] memory hops = new RawHop[](1);
        hops[0] = RawHop(kind, address(nvda), 500, 0, address(0));
        RawLeg[] memory legs = new RawLeg[](1);
        legs[0] = RawLeg(1e6, hops);
        bytes memory data = abi.encodeWithSelector(
            exactOut ? RouterStockfill.swapExactOut.selector : RouterStockfill.swap.selector,
            address(usdg),
            address(nvda),
            legs,
            exactOut ? 2e6 : 0,
            user,
            block.timestamp
        );
        vm.prank(user);
        (ok, ret) = address(router).call(data);
    }

    function test_revert_hopKindOutOfRange() public {
        (bool ok,) = _rawSwap(0, false); // kind 0 (V3) is valid
        assertTrue(ok);
        for (uint8 k = 4; k < 8; ++k) {
            (ok,) = _rawSwap(k, false);
            assertFalse(ok, "exact in accepted kind >= 4");
            (ok,) = _rawSwap(k, true);
            assertFalse(ok, "exact out accepted kind >= 4");
        }
        (ok,) = _rawSwap(255, true);
        assertFalse(ok);
    }

    function test_revert_invalidPaths() public {
        address u = address(usdg);
        address n = address(nvda);
        address w = address(weth);
        uint256 ts = block.timestamp;
        vm.startPrank(user);

        // WRAP from a token, or to something other than WETH
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap(u, w, _legs(1e6, _path(_hopWrap(w))), 0, user, ts);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap{value: 1}(NATIVE, n, _legs(1, _path(Hop(HopKind.WRAP, n, 0, 0, address(0)))), 0, user, ts);
        // UNWRAP from ETH (ETH is not WETH) or from a token, or to a token
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap{value: 1}(NATIVE, w, _legs(1, _path(_hopUnwrap())), 0, user, ts);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap(u, NATIVE, _legs(1e6, _path(_hopUnwrap())), 0, user, ts);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap(w, n, _legs(1e6, _path(Hop(HopKind.UNWRAP, n, 0, 0, address(0)))), 0, user, ts);
        // v3 into or out of native ETH
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap{value: 1}(NATIVE, n, _legs(1, _path(_hopV3(n, 500))), 0, user, ts);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 1));
        router.swap(w, NATIVE, _legs(1e6, _path(_hopV3(u, 500), _hopV3(NATIVE, 500))), 0, user, ts);
        // a hop to the token it starts from (v3 and v4)
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 1));
        router.swap(u, n, _legs(1e6, _path(_hopV3(n, 500), _hopV4(n, 3000, 60, address(0)))), 0, user, ts);
        // the second leg is the bad one
        Leg[] memory two = new Leg[](2);
        two[0] = Leg(1e6, _path(_hopV3(n, 500)));
        two[1] = Leg(1e6, _path(_hopV3(u, 500)));
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 1, 0));
        router.swap(u, n, two, 0, user, ts);
        // a leg ending elsewhere
        two[1] = Leg(1e6, _path(_hopV3(w, 500)));
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(u, n, two, 0, user, ts);
        // same token in and out, zero-amount leg, zero recipient
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(u, u, _legs(1e6, _path(_hopV3(n, 500), _hopV3(u, 3000))), 0, user, ts);
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(u, n, _legs(0, _path(_hopV3(n, 500))), 0, user, ts);
        vm.expectRevert(RouterStockfill.BadRecipient.selector);
        router.swap(u, n, _legs(1e6, _path(_hopV3(n, 500))), 0, address(0), ts);
        // five hops
        Hop[] memory five = new Hop[](5);
        five[0] = _hopV3(n, 500);
        five[1] = _hopV3(u, 500);
        five[2] = _hopV3(n, 500);
        five[3] = _hopV3(u, 500);
        five[4] = _hopV3(n, 500);
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(u, n, _legs(1e6, five), 0, user, ts);
        vm.stopPrank();
    }

    /// A path that revisits tokenIn mid-route charges exactly what the pools took and delivers exactly
    /// what they paid out, in both directions.
    function test_cycle_throughTokenIn_exactInAndExactOut() public {
        // USDG -v3 .05%-> NVDA -v4-> USDG -v3 .3%-> NVDA -v3-> TSLA, every pool distinct
        Hop[] memory p = _path4(
            _hopV3(address(nvda), 500),
            _hopV4(address(usdg), 3000, 60, address(0)),
            _hopV3(address(nvda), 3000),
            _hopV3(address(tsla), 3000)
        );
        uint256 q = _quote(address(usdg), p, 1_000e6);
        uint256 uBefore = usdg.balanceOf(user);
        uint256 tBefore = tsla.balanceOf(user);
        assertEq(_swap(address(usdg), address(tsla), _legs(1_000e6, p), q), q);
        assertEq(uBefore - usdg.balanceOf(user), 1_000e6);
        assertEq(tsla.balanceOf(user) - tBefore, q);
        _assertRouterEmpty();

        uint256 qo = _quoteOut(address(usdg), p, 1e9);
        uBefore = usdg.balanceOf(user);
        tBefore = tsla.balanceOf(user);
        assertEq(_swapExactOut(address(usdg), address(tsla), _legs(1e9, p), qo * 2), qo);
        assertEq(uBefore - usdg.balanceOf(user), qo, "charged exactly the net USDG spent");
        assertEq(tsla.balanceOf(user) - tBefore, 1e9);
        _assertRouterEmpty();
    }

    /// Same as above with tokenOut appearing mid-route.
    function test_cycle_throughTokenOut_exactInAndExactOut() public {
        // USDG -v3-> NVDA -v4-> USDG -v3 .3%-> NVDA
        Hop[] memory p =
            _path(_hopV3(address(nvda), 500), _hopV4(address(usdg), 3000, 60, address(0)), _hopV3(address(nvda), 3000));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        uint256 nBefore = nvda.balanceOf(user);
        assertEq(_swap(address(usdg), address(nvda), _legs(1_000e6, p), q), q);
        assertEq(nvda.balanceOf(user) - nBefore, q);
        _assertRouterEmpty();

        uint256 qo = _quoteOut(address(usdg), p, 1e9);
        uint256 uBefore = usdg.balanceOf(user);
        nBefore = nvda.balanceOf(user);
        assertEq(_swapExactOut(address(usdg), address(nvda), _legs(1e9, p), qo * 2), qo);
        assertEq(uBefore - usdg.balanceOf(user), qo);
        assertEq(nvda.balanceOf(user) - nBefore, 1e9);
        _assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                               DONATIONS
    //////////////////////////////////////////////////////////////*/

    struct Donations {
        uint256 usdg;
        uint256 nvda;
        uint256 tsla;
        uint256 meme;
        uint256 weth;
        uint256 eth;
    }

    function _donate(Donations memory d) internal {
        usdg.mint(address(router), d.usdg);
        nvda.mint(address(router), d.nvda);
        tsla.mint(address(router), d.tsla);
        meme.mint(address(router), d.meme);
        weth.transfer(address(router), d.weth);
        vm.deal(address(router), d.eth); // as if force-sent
    }

    function _assertDonations(Donations memory d) internal view {
        assertEq(usdg.balanceOf(address(router)), d.usdg, "USDG donation moved");
        assertEq(nvda.balanceOf(address(router)), d.nvda, "NVDA donation moved");
        assertEq(tsla.balanceOf(address(router)), d.tsla, "TSLA donation moved");
        assertEq(meme.balanceOf(address(router)), d.meme, "MEME donation moved");
        assertEq(weth.balanceOf(address(router)), d.weth, "WETH donation moved");
        assertEq(address(router).balance, d.eth, "ETH donation moved");
    }

    /// Router balances (donations, force-sent ETH) are never paid out, never spent for a caller and
    /// never reduce what a caller pays.
    function test_donations_neverExtractable() public {
        Donations memory d = Donations(7e9, 5e18, 3e18, 9e18, 2e18, 1 ether);
        _donate(d);

        // exact in and out, ERC20 to ERC20, ETH in and out, wrap and unwrap
        Hop[] memory uToN = _path(_hopV3(address(nvda), 500));
        uint256 q = _quote(address(usdg), uToN, 1_000e6);
        assertEq(_swap(address(usdg), address(nvda), _legs(1_000e6, uToN), q), q);
        _assertDonations(d);

        Hop[] memory uToN4 = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        q = _quoteOut(address(usdg), uToN4, 1e9);
        uint256 before = usdg.balanceOf(user);
        assertEq(_swapExactOut(address(usdg), address(nvda), _legs(1e9, uToN4), q * 2), q);
        assertEq(before - usdg.balanceOf(user), q);
        _assertDonations(d);

        Hop[] memory eToM = _path(_hopV4(address(meme), 3000, 60, address(0)));
        q = _quote(NATIVE, eToM, 1 ether);
        assertEq(_swapETH(address(meme), _legs(1 ether, eToM), 1 ether, q), q);
        _assertDonations(d);

        Hop[] memory eToU = _path(_hopWrap(address(weth)), _hopV3(address(usdg), 500));
        q = _quoteOut(NATIVE, eToU, 1e6);
        before = user.balance;
        assertEq(_swapExactOutETH(address(usdg), _legs(1e6, eToU), q + 3 ether), q);
        assertEq(before - user.balance, q, "ETH refund excludes the router's own ETH");
        _assertDonations(d);

        Hop[] memory mToE = _path(_hopV3(address(weth), 10000), _hopUnwrap());
        q = _quoteOut(address(meme), mToE, 1e17);
        before = user.balance;
        assertEq(_swapExactOut(address(meme), NATIVE, _legs(1e17, mToE), q * 2), q);
        assertEq(user.balance - before, 1e17, "exactly the output, not the router's ETH");
        _assertDonations(d);

        // A maximum one wei below the price is not topped up from router balances, ERC20 or ETH.
        q = _quoteOut(address(usdg), uToN4, 1e9);
        usdg.mint(attacker, 1e12);
        vm.startPrank(attacker);
        usdg.approve(address(router), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, q, q - 1));
        router.swapExactOut(address(usdg), address(nvda), _legs(1e9, uToN4), q - 1, attacker, block.timestamp);
        vm.stopPrank();

        q = _quoteOut(NATIVE, eToU, 1e6);
        vm.deal(attacker, 10 ether);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, q, q - 1));
        router.swapExactOut{value: q - 1}(NATIVE, address(usdg), _legs(1e6, eToU), q - 1, attacker, block.timestamp);

        // A minimum that includes the donation is not met.
        q = _quote(address(usdg), uToN, 1_000e6);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooLittleReceived.selector, q, q + d.nvda));
        router.swap(address(usdg), address(nvda), _legs(1_000e6, uToN), q + d.nvda, attacker, block.timestamp);

        // Wrapping 1 wei yields 1 wei of WETH, not the donated WETH.
        vm.prank(attacker);
        assertEq(
            router.swap{value: 1}(
                NATIVE, address(weth), _legs(1, _path(_hopWrap(address(weth)))), 0, attacker, block.timestamp
            ),
            1
        );
        assertEq(weth.balanceOf(attacker), 1);
        _assertDonations(d);
    }

    function testFuzz_donations_neverMove(uint96 dU, uint96 dN, uint64 dE, uint64 amount, bool exactOut, bool viaV4)
        public
    {
        Donations memory d = Donations(dU, dN, 0, 0, 0, dE);
        _donate(d);
        amount = uint64(bound(amount, 1e6, 1e15));
        Hop[] memory p = _path(viaV4 ? _hopV4(address(nvda), 3000, 60, address(0)) : _hopV3(address(nvda), 500));
        uint256 uBefore = usdg.balanceOf(user);
        uint256 nBefore = nvda.balanceOf(user);
        if (exactOut) {
            uint256 q = _quoteOut(address(usdg), p, amount);
            assertEq(_swapExactOut(address(usdg), address(nvda), _legs(amount, p), q + dU), q);
            assertEq(uBefore - usdg.balanceOf(user), q);
            assertEq(nvda.balanceOf(user) - nBefore, amount);
        } else {
            uint256 q = _quote(address(usdg), p, amount);
            assertEq(_swap(address(usdg), address(nvda), _legs(amount, p), 0), q);
            assertEq(uBefore - usdg.balanceOf(user), amount);
            assertEq(nvda.balanceOf(user) - nBefore, q);
        }
        _assertDonations(d);
    }

    /// A fee-on-transfer token reverts anywhere in a route. As an intermediate the router is short by
    /// the fee; even with a router balance to cover it, the router-to-pool transfer is taxed again and
    /// the pool's balance check fails (v3 `IIA`, v4 `CurrencyNotSettled`). As the output it fails with
    /// OutputNotReceived. The router's own balance is never consumed.
    function test_revert_feeOnTransferAnywhereInRoute() public {
        ToggleTaxToken tt = new ToggleTaxToken();
        tt.mint(address(this), 1e40);
        tt.approve(address(lp3), type(uint256).max);
        tt.approve(address(lp4), type(uint256).max);
        _v3Pool(address(usdg), address(tt), 500, PRICE_1_1, DEEP);
        _v3Pool(address(tt), address(nvda), 500, PRICE_1_1, DEEP);
        _v4Pool(address(tt), address(nvda), 3000, 60, address(0), PRICE_1_1, DEEP4);
        tt.setTaxed(true);

        Hop[] memory p = _path(_hopV3(address(tt), 500), _hopV3(address(nvda), 500));
        Hop[] memory p4 = _path(_hopV3(address(tt), 500), _hopV4(address(nvda), 3000, 60, address(0)));
        vm.startPrank(user);
        vm.expectRevert(); // router can't pay the second pool what the first reported
        router.swap(address(usdg), address(nvda), _legs(1_000e6, p), 0, user, block.timestamp);
        vm.expectRevert();
        router.swapExactOut(address(usdg), address(nvda), _legs(1e9, p), 1e12, user, block.timestamp);
        vm.stopPrank();

        tt.setTaxed(false);
        tt.transfer(address(router), 1e18);
        tt.setTaxed(true);
        vm.startPrank(user);
        vm.expectRevert(bytes("IIA"));
        router.swap(address(usdg), address(nvda), _legs(1_000e6, p), 0, user, block.timestamp);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        router.swap(address(usdg), address(nvda), _legs(1_000e6, p4), 0, user, block.timestamp);
        vm.expectRevert();
        router.swapExactOut(address(usdg), address(nvda), _legs(1e9, p), 1e12, user, block.timestamp);

        // as the output token
        Hop[] memory out = _path(_hopV3(address(tt), 500));
        vm.expectRevert(RouterStockfill.OutputNotReceived.selector);
        router.swap(address(usdg), address(tt), _legs(1_000e6, out), 0, user, block.timestamp);
        vm.stopPrank();
        assertEq(tt.balanceOf(address(router)), 1e18, "router balance untouched");
    }

    /*//////////////////////////////////////////////////////////////
                              AMOUNTS
    //////////////////////////////////////////////////////////////*/

    function test_revert_amountTooLargeOrOverflow() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        Leg[] memory two = new Leg[](2);
        two[0] = Leg(1 << 127, p);
        two[1] = Leg(1 << 127, p);
        vm.startPrank(user);
        vm.expectRevert(RouterStockfill.AmountTooLarge.selector);
        router.swap(address(usdg), address(nvda), two, 0, user, block.timestamp);
        two[0] = Leg(type(uint256).max, p);
        two[1] = Leg(1, p);
        vm.expectRevert(stdError.arithmeticError);
        router.swap(address(usdg), address(nvda), two, 0, user, block.timestamp);
        vm.expectRevert(RouterStockfill.AmountTooLarge.selector);
        router.swapExactOut(address(usdg), address(nvda), _legs(1, p), MAX_AMOUNT + 1, user, block.timestamp);
        vm.expectRevert(RouterStockfill.AmountTooLarge.selector);
        router.swapExactOut(address(usdg), address(nvda), _legs(MAX_AMOUNT + 1, p), MAX_AMOUNT, user, block.timestamp);
        vm.stopPrank();
    }

    /// Exact input that rounds to zero output is a PartialFill; exact output of 1 wei costs a few wei
    /// and delivers exactly 1.
    function test_amounts_oneWei() public {
        Hop[] memory v3p = _path(_hopV3(address(nvda), 500));
        Hop[] memory v4p = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        vm.startPrank(user);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swap(address(usdg), address(nvda), _legs(1, v3p), 0, user, block.timestamp);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swap(address(usdg), address(nvda), _legs(1, v4p), 0, user, block.timestamp);
        vm.stopPrank();
        uint256 before = nvda.balanceOf(user);
        uint256 spent = _swapExactOut(address(usdg), address(nvda), _legs(1, v3p), 10);
        assertGt(spent, 0);
        spent = _swapExactOut(address(usdg), address(nvda), _legs(1, v4p), 10);
        assertGt(spent, 0);
        assertEq(nvda.balanceOf(user) - before, 2);
        _assertRouterEmpty();
    }

    /// Ten legs of four hops, exact input and nested exact output, fit comfortably in a block.
    function test_gas_maxRoute() public {
        Hop[] memory p = _path4(
            _hopV3(address(nvda), 500),
            _hopV4(address(usdg), 3000, 60, address(0)),
            _hopV3(address(nvda), 3000),
            _hopV3(address(tsla), 3000)
        );
        Leg[] memory legs = new Leg[](10);
        for (uint256 i; i < 10; ++i) {
            legs[i] = Leg(1e8, p);
        }
        uint256 g = gasleft();
        _swap(address(usdg), address(tsla), legs, 0);
        uint256 gIn = g - gasleft();
        g = gasleft();
        _swapExactOut(address(usdg), address(tsla), legs, 1e10);
        uint256 gOut = g - gasleft();
        console2.log("10x4 exact in gas", gIn);
        console2.log("10x4 exact out gas", gOut);
        assertLt(gIn, 8_000_000);
        assertLt(gOut, 10_000_000);
        _assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                                PERMITS
    //////////////////////////////////////////////////////////////*/

    /// A front-run permit followed by a failed swap leaves an allowance to the router that only the
    /// signer can spend, since every entry point pulls from msg.sender.
    function test_permit_frontRunThenFailedSwap_allowanceUsableOnlyBySigner() public {
        (address victim, uint256 key) = makeAddrAndKey("victim");
        usdg.mint(victim, 1e12);
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        Leg[] memory legs = _legs(1_000e6, p);
        Permit memory pm = _permit(victim, key, 1_000e6, block.timestamp + 600);

        usdg.permit(victim, address(router), 1_000e6, pm.deadline, pm.v, pm.r, pm.s); // front-run
        vm.prank(victim);
        vm.expectRevert(); // fails its own minimum
        router.swapWithPermit(
            Trade(address(usdg), address(nvda), false, type(uint128).max, victim, block.timestamp), legs, pm
        );
        assertEq(usdg.allowance(victim, address(router)), 1_000e6, "allowance left behind");

        usdg.mint(attacker, 1);
        vm.startPrank(attacker);
        vm.expectRevert();
        router.swap(address(usdg), address(nvda), legs, 0, attacker, block.timestamp);
        vm.expectRevert();
        router.swapExactOut(address(usdg), address(nvda), _legs(1e6, p), 1_000e6, attacker, block.timestamp);
        vm.expectRevert();
        router.swapWithPermit(Trade(address(usdg), address(nvda), false, 0, attacker, block.timestamp), legs, pm);
        vm.stopPrank();
        assertEq(usdg.balanceOf(victim), 1e12, "nobody else moved the victim's tokens");

        vm.prank(victim);
        (uint256 amountIn,) =
            router.swapWithPermit(Trade(address(usdg), address(nvda), false, 0, victim, block.timestamp), legs, pm);
        assertEq(amountIn, 1_000e6);
        assertEq(usdg.allowance(victim, address(router)), 0, "allowance used up exactly");
    }

    /// A Permit2 signature names the router as spender and the router binds the owner to msg.sender,
    /// so it is usable only by the signer through the router, and only once.
    function test_permit2_signatureNotUsableOutsideRouterOrTwice() public {
        (address victim, uint256 key) = makeAddrAndKey("victim2");
        usdg.mint(victim, 1e12);
        vm.prank(victim);
        usdg.approve(permit2, type(uint256).max);
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        Permit2Transfer memory sig =
            _permit2Sig(key, address(usdg), address(router), 5_000e6, 77, block.timestamp + 600);

        // directly on Permit2: the signed spender is the router
        vm.prank(attacker);
        vm.expectRevert();
        ISignatureTransfer(permit2)
            .permitTransferFrom(
                ISignatureTransfer.PermitTransferFrom(
                    ISignatureTransfer.TokenPermissions(address(usdg), 5_000e6), 77, sig.deadline
                ),
                ISignatureTransfer.SignatureTransferDetails(attacker, 5_000e6),
                victim,
                sig.signature
            );
        // through the router by another caller: the owner is msg.sender
        vm.prank(attacker);
        vm.expectRevert();
        router.swapWithPermit2(
            Trade(address(usdg), address(nvda), false, 0, attacker, block.timestamp), _legs(1_000e6, p), sig
        );

        vm.prank(victim);
        (uint256 amountIn,) = router.swapWithPermit2(
            Trade(address(usdg), address(nvda), false, 0, victim, block.timestamp), _legs(1_000e6, p), sig
        );
        assertEq(amountIn, 1_000e6);
        assertEq(usdg.balanceOf(victim), 1e12 - 1_000e6, "only the pull moved, not the signed amount");
        vm.prank(victim);
        vm.expectRevert(); // nonce spent, so the unused 4,000 cannot be pulled
        router.swapWithPermit2(
            Trade(address(usdg), address(nvda), false, 0, victim, block.timestamp), _legs(1_000e6, p), sig
        );
    }

    /*//////////////////////////////////////////////////////////////
                       REFUNDS, RECIPIENTS AND NESTING
    //////////////////////////////////////////////////////////////*/

    /// Exact-output ETH refunds go to msg.sender, so a caller that cannot receive ETH must send the
    /// exact cost.
    function test_refund_callerWithoutReceive() public {
        NoEthCaller c = new NoEthCaller();
        Hop[] memory p = _path(_hopV4(address(meme), 3000, 60, address(0)));
        uint256 q = _quoteOut(NATIVE, p, 1e18);
        vm.expectRevert(RouterStockfill.TransferFailed.selector);
        c.buy{value: q + 1}(router, address(meme), _legs(1e18, p), q + 1);
        c.buy{value: q}(router, address(meme), _legs(1e18, p), q);
        _assertRouterEmpty();
    }

    /// Inside someone else's PoolManager unlock, routes with a v4 hop revert with AlreadyUnlocked;
    /// v3-only routes work.
    function test_insideForeignUnlock_onlyV3Routes() public {
        Unlocker u = new Unlocker(manager, address(router));
        usdg.mint(address(u), 1e12);
        u.approve(address(usdg));

        Hop[] memory p4 = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        u.run(
            abi.encodeCall(router.swap, (address(usdg), address(nvda), _legs(1e6, p4), 0, address(u), block.timestamp))
        );
        assertFalse(u.lastOk());
        assertEq(bytes4(u.lastRet()), IPoolManager.AlreadyUnlocked.selector);

        Hop[] memory p3 = _path(_hopV3(address(nvda), 500));
        u.run(
            abi.encodeCall(router.swap, (address(usdg), address(nvda), _legs(1e6, p3), 0, address(u), block.timestamp))
        );
        assertTrue(u.lastOk());
    }

    /// The router as recipient would strand the output, so it is rejected like address(0).
    function test_revert_recipientIsRouter() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.BadRecipient.selector);
        router.swap(address(usdg), address(nvda), _legs(1_000e6, p), 0, address(router), block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                                 QUOTER
    //////////////////////////////////////////////////////////////*/

    /// Router and quoter agree to the wei on a mixed native/v4/v3/unwrap path, both directions.
    function testFuzz_quoteParity_mixedNative(uint64 amount, bool exactOut) public {
        // ETH -v4-> MEME -v3 1%-> WETH -v3 .05%-> USDG
        Hop[] memory p = _path(
            _hopV4(address(meme), 3000, 60, address(0)), _hopV3(address(weth), 10000), _hopV3(address(usdg), 500)
        );
        if (exactOut) {
            amount = uint64(bound(amount, 1e3, 1e9));
            uint256 q = _quoteOut(NATIVE, p, amount);
            uint256 before = user.balance;
            uint256 uBefore = usdg.balanceOf(user);
            assertEq(_swapExactOutETH(address(usdg), _legs(amount, p), q + 1 ether), q);
            assertEq(before - user.balance, q);
            assertEq(usdg.balanceOf(user) - uBefore, amount);
        } else {
            amount = uint64(bound(amount, 1e12, 10 ether));
            uint256 q = _quote(NATIVE, p, amount);
            assertEq(_swapETH(address(usdg), _legs(amount, p), amount, q), q);
        }
        _assertRouterEmpty();
    }

    /// A token reverting with V3Result-shaped data cannot spoof a quote: the v3 pool replaces any
    /// transfer revert with "TF".
    function test_quoter_tokenCannotSpoofV3Result() public {
        SpoofToken sp = new SpoofToken();
        sp.mint(address(this), 1e40);
        sp.approve(address(lp3), type(uint256).max);
        _v3Pool(address(usdg), address(sp), 500, PRICE_1_1, DEEP);
        sp.setSpoof(true);
        Hop[] memory p = _path(_hopV3(address(sp), 500));
        vm.expectRevert(bytes("TF"));
        quoter.quotePath(address(usdg), p, 1e6);

        Hop[][] memory paths = new Hop[][](1);
        paths[0] = p;
        uint256[][] memory amounts = new uint256[][](1);
        amounts[0] = new uint256[](1);
        amounts[0][0] = 1e6;
        assertEq(quoter.quoteMany(address(usdg), paths, amounts)[0][0], 0);
    }
}
