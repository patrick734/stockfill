// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Venues, TaxToken} from "./Base.t.sol";
import {RouterStockfill} from "../src/RouterStockfill.sol";
import {NATIVE, HopKind, Hop, Leg} from "../src/RouteTypes.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract RouterStockfillTest is Venues {
    /*//////////////////////////////////////////////////////////////
                              SINGLE HOPS
    //////////////////////////////////////////////////////////////*/

    function test_v3SingleHop_matchesQuote() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        uint256 before = nvda.balanceOf(user);
        uint256 out = _swap(address(usdg), address(nvda), _legs(1_000e6, p), q);
        assertEq(out, q);
        assertEq(nvda.balanceOf(user) - before, q);
        _assertRouterEmpty();
    }

    function test_v4SingleHop_matchesQuote() public {
        Hop[] memory p = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        assertGt(q, 0);
        uint256 out = _swap(address(usdg), address(nvda), _legs(1_000e6, p), q);
        assertEq(out, q);
        _assertRouterEmpty();
    }

    function test_v4NativeETH_in() public {
        Hop[] memory p = _path(_hopV4(address(meme), 3000, 60, address(0)));
        uint256 q = _quote(NATIVE, p, 1 ether);
        uint256 out = _swapETH(address(meme), _legs(1 ether, p), 1 ether, q);
        assertEq(out, q);
        _assertRouterEmpty();
    }

    function test_v4NativeETH_out() public {
        Hop[] memory p = _path(_hopV4(NATIVE, 3000, 60, address(0)));
        uint256 q = _quote(address(meme), p, 1 ether);
        uint256 before = user.balance;
        uint256 out = _swap(address(meme), NATIVE, _legs(1 ether, p), q);
        assertEq(out, q);
        assertEq(user.balance - before, q);
        _assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                           MULTI-HOP AND WRAP
    //////////////////////////////////////////////////////////////*/

    function test_multiHop_v3ThenV4() public {
        // USDG -v3-> NVDA -v3-> TSLA -v4-> MEME
        Hop[] memory p =
            _path(_hopV3(address(nvda), 500), _hopV3(address(tsla), 3000), _hopV4(address(meme), 3000, 60, address(0)));
        (uint256 q, uint256[] memory hops) = quoter.quotePath(address(usdg), p, 500e6);
        assertEq(hops.length, 3);
        assertEq(hops[2], q);
        uint256 out = _swap(address(usdg), address(meme), _legs(500e6, p), q);
        assertEq(out, q);
        _assertRouterEmpty();
    }

    function test_wrapThenV3() public {
        // ETH -> WETH -v3-> MEME
        Hop[] memory p = _path(_hopWrap(address(weth)), _hopV3(address(meme), 10000));
        uint256 q = _quote(NATIVE, p, 2 ether);
        uint256 out = _swapETH(address(meme), _legs(2 ether, p), 2 ether, q);
        assertEq(out, q);
        _assertRouterEmpty();
    }

    function test_v3ThenUnwrap() public {
        // MEME -v3-> WETH -> ETH
        Hop[] memory p = _path(_hopV3(address(weth), 10000), _hopUnwrap());
        uint256 q = _quote(address(meme), p, 2 ether);
        uint256 before = user.balance;
        uint256 out = _swap(address(meme), NATIVE, _legs(2 ether, p), q);
        assertEq(out, q);
        assertEq(user.balance - before, q);
        _assertRouterEmpty();
    }

    function test_v4EthThenV3Weth_mixed() public {
        // MEME -v4-> ETH -> WETH -v3-> USDG: a native v4 pool feeding a WETH v3 pool
        Hop[] memory p =
            _path(_hopV4(NATIVE, 3000, 60, address(0)), _hopWrap(address(weth)), _hopV3(address(usdg), 500));
        uint256 q = _quote(address(meme), p, 1 ether);
        uint256 out = _swap(address(meme), address(usdg), _legs(1 ether, p), q);
        assertEq(out, q);
        _assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                                 SPLITS
    //////////////////////////////////////////////////////////////*/

    function test_split_threeVenues_beatsBestSingle() public {
        uint256 amount = 3e23; // ~30% of a pool's depth: moves any single pool a lot
        Hop[] memory a = _path(_hopV3(address(nvda), 500));
        Hop[] memory b = _path(_hopV3(address(nvda), 3000));
        Hop[] memory c = _path(_hopV4(address(nvda), 3000, 60, address(0)));

        uint256 single = _quote(address(usdg), a, amount);
        uint256 qa = _quote(address(usdg), a, amount * 6 / 10);
        uint256 qb = _quote(address(usdg), b, amount * 1 / 10);
        uint256 qc = _quote(address(usdg), c, amount * 3 / 10);

        Leg[] memory legs = new Leg[](3);
        legs[0] = Leg(amount * 6 / 10, a);
        legs[1] = Leg(amount * 1 / 10, b);
        legs[2] = Leg(amount * 3 / 10, c);

        uint256 out = _swap(address(usdg), address(nvda), legs, qa + qb + qc);
        assertEq(out, qa + qb + qc, "split = sum of independent quotes (disjoint pools)");
        assertGt(out, single, "split beats the best single path");
        _assertRouterEmpty();
    }

    function testFuzz_split_equalsSumOfQuotes(uint256 amount, uint8 pctA) public {
        amount = bound(amount, 1e6, 500_000e6);
        pctA = uint8(bound(pctA, 1, 99));
        uint256 inA = amount * pctA / 100;
        uint256 inB = amount - inA;
        vm.assume(inA > 0 && inB > 0);
        Hop[] memory a = _path(_hopV3(address(nvda), 500));
        Hop[] memory b = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        uint256 q = _quote(address(usdg), a, inA) + _quote(address(usdg), b, inB);
        Leg[] memory legs = new Leg[](2);
        legs[0] = Leg(inA, a);
        legs[1] = Leg(inB, b);
        uint256 out = _swap(address(usdg), address(nvda), legs, q);
        assertEq(out, q);
        _assertRouterEmpty();
    }

    function test_quoteMany_batch() public {
        Hop[][] memory paths = new Hop[][](2);
        paths[0] = _path(_hopV3(address(nvda), 500));
        paths[1] = _path(_hopV3(address(nvda), 100)); // no such pool -> 0
        uint256[][] memory amts = new uint256[][](2);
        amts[0] = new uint256[](2);
        amts[0][0] = 1e6;
        amts[0][1] = 2e6;
        amts[1] = new uint256[](1);
        amts[1][0] = 1e6;
        uint256[][] memory outs = quoter.quoteMany(address(usdg), paths, amts);
        assertGt(outs[0][0], 0);
        assertGt(outs[0][1], outs[0][0]);
        assertEq(outs[1][0], 0);
    }

    /*//////////////////////////////////////////////////////////////
                              PROTECTIONS
    //////////////////////////////////////////////////////////////*/

    function test_revert_tooLittleReceived() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooLittleReceived.selector, q, q + 1));
        router.swap(address(usdg), address(nvda), _legs(1_000e6, p), q + 1, user, block.timestamp);
    }

    function test_revert_expired() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.Expired.selector);
        router.swap(address(usdg), address(nvda), _legs(1e6, p), 0, user, block.timestamp - 1);
    }

    function test_revert_partialFill_v3() public {
        // A pool with a sliver of liquidity cannot absorb a big order in full.
        _v3Pool(address(usdg), address(tsla), 3000, PRICE_1_1, 1e6);
        Hop[] memory p = _path(_hopV3(address(tsla), 3000));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swap(address(usdg), address(tsla), _legs(1e30, p), 0, user, block.timestamp);
        vm.expectRevert(abi.encodeWithSignature("PartialFill(uint256)", 0));
        quoter.quotePath(address(usdg), p, 1e30);
    }

    function test_revert_partialFill_v4() public {
        _v4Pool(address(usdg), address(tsla), 500, 10, address(0), PRICE_1_1, 1e6);
        Hop[] memory p = _path(_hopV4(address(tsla), 500, 10, address(0)));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swap(address(usdg), address(tsla), _legs(1e30, p), 0, user, block.timestamp);
    }

    function test_revert_noPool() public {
        Hop[] memory p = _path(_hopV3(address(tsla), 500));
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(RouterStockfill.NoPool.selector, address(usdg), address(tsla), uint24(500))
        );
        router.swap(address(usdg), address(tsla), _legs(1e6, p), 0, user, block.timestamp);
    }

    function test_revert_routeEndsInWrongToken() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(address(usdg), address(tsla), _legs(1e6, p), 0, user, block.timestamp);
    }

    function test_revert_badWrapHop() public {
        Hop[] memory p = _path(_hopWrap(address(weth)), _hopV3(address(meme), 10000));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap(address(usdg), address(meme), _legs(1e6, p), 0, user, block.timestamp); // wrap from USDG
    }

    function test_revert_v3HopWithNativeToken() public {
        Hop[] memory p = _path(_hopV3(address(meme), 10000));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.BadHop.selector, 0, 0));
        router.swap{value: 1 ether}(NATIVE, address(meme), _legs(1 ether, p), 0, user, block.timestamp);
    }

    function test_revert_wrongMsgValue() public {
        Hop[] memory p = _path(_hopV4(address(meme), 3000, 60, address(0)));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.BadValue.selector);
        router.swap{value: 1 ether}(NATIVE, address(meme), _legs(2 ether, p), 0, user, block.timestamp);
        // and ETH sent alongside a token swap
        Hop[] memory q = _path(_hopV3(address(nvda), 500));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.BadValue.selector);
        router.swap{value: 1}(address(usdg), address(nvda), _legs(1e6, q), 0, user, block.timestamp);
    }

    function test_revert_emptyAndOversizedRoutes() public {
        vm.startPrank(user);
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(address(usdg), address(nvda), new Leg[](0), 0, user, block.timestamp);

        Leg[] memory many = new Leg[](11);
        for (uint256 i; i < 11; ++i) {
            many[i] = Leg(1e6, _path(_hopV3(address(nvda), 500)));
        }
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(address(usdg), address(nvda), many, 0, user, block.timestamp);

        Leg[] memory zero = _legs(0, _path(_hopV3(address(nvda), 500)));
        vm.expectRevert(RouterStockfill.BadRoute.selector);
        router.swap(address(usdg), address(nvda), zero, 0, user, block.timestamp);

        vm.expectRevert(RouterStockfill.BadRecipient.selector);
        router.swap(
            address(usdg), address(nvda), _legs(1e6, _path(_hopV3(address(nvda), 500))), 0, address(0), block.timestamp
        );
        vm.stopPrank();
    }

    function test_revert_feeOnTransferInput() public {
        TaxToken tax = new TaxToken();
        tax.mint(user, 1e24);
        vm.prank(user);
        tax.approve(address(router), type(uint256).max);
        Hop[] memory p = _path(_hopV3(address(nvda), 500)); // route never reached
        vm.prank(user);
        vm.expectRevert(RouterStockfill.InputNotReceived.selector);
        router.swap(address(tax), address(nvda), _legs(1e18, p), 0, user, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                               CALLBACKS
    //////////////////////////////////////////////////////////////*/

    function test_revert_v3CallbackDirectCall() public {
        deal(address(usdg), address(router), 1e6);
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.uniswapV3SwapCallback(1e6, 0, abi.encode(address(usdg)));
        // A real pool cannot call it outside a swap either.
        address realPool = v3.getPool(address(usdg), address(nvda), 500);
        vm.prank(realPool);
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.uniswapV3SwapCallback(1e6, 0, "");
    }

    function test_revert_unlockCallbackDirectCall() public {
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.unlockCallback("");
        // Nor can the PoolManager outside a swap.
        vm.prank(address(manager));
        vm.expectRevert(RouterStockfill.UnauthorizedCallback.selector);
        router.unlockCallback("");
    }

    function test_revert_unsolicitedETH() public {
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_revert_reentrancy() public {
        ReenteringToken evil = new ReenteringToken(router);
        evil.mint(user, 1e24);
        vm.prank(user);
        evil.approve(address(router), type(uint256).max);
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.Reentered.selector);
        router.swap(address(evil), address(nvda), _legs(1e18, p), 0, user, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                                V4 HOOKS
    //////////////////////////////////////////////////////////////*/

    function test_v4HookTakingFee_quoteMatches() public {
        address hook = _feeHookAddress();
        _v4Pool(address(usdg), address(tsla), 3000, 60, hook, PRICE_1_1, DEEP4);
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, hook));
        uint256 q = _quote(address(usdg), p, 1_000e6);
        assertGt(q, 0);
        uint256 out = _swap(address(usdg), address(tsla), _legs(1_000e6, p), q);
        assertEq(out, q, "hook fee is in the quote, so the quote still holds");
        _assertRouterEmpty();
    }

    function test_leftoverDust_neverKept() public {
        Hop[] memory buy = _path(_hopV3(address(nvda), 500));
        Hop[] memory sell = _path(_hopV4(address(usdg), 3000, 60, address(0)));
        for (uint256 i; i < 5; ++i) {
            uint256 got = _swap(address(usdg), address(nvda), _legs(12_345e6 + i, buy), 0);
            _swap(address(nvda), address(usdg), _legs(got, sell), 0);
        }
        _assertRouterEmpty();
    }
}

/// Tries to re-enter the router from inside transferFrom.
contract ReenteringToken is MockERC20 {
    RouterStockfill immutable r;

    constructor(RouterStockfill _r) MockERC20("Evil", "EVIL", 18) {
        r = _r;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        Leg[] memory legs = new Leg[](1);
        Hop[] memory hops = new Hop[](1);
        hops[0] = Hop(HopKind.V3, address(0xdead), 500, 0, address(0));
        legs[0] = Leg(1, hops);
        r.swap(address(this), address(0xbeef), legs, 0, from, block.timestamp);
        return super.transferFrom(from, to, amount);
    }
}
