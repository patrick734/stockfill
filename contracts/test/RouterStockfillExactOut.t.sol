// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Venues, TaxToken} from "./Base.t.sol";
import {RouterStockfill} from "../src/RouterStockfill.sol";
import {NATIVE, Hop, Leg} from "../src/RouteTypes.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract RouterStockfillExactOutTest is Venues {
    struct Balances {
        uint256 tokenIn;
        uint256 tokenOut;
    }

    function _balances(address tokenIn, address tokenOut) internal view returns (Balances memory b) {
        b.tokenIn = tokenIn == NATIVE ? user.balance : MockERC20(tokenIn).balanceOf(user);
        b.tokenOut = tokenOut == NATIVE ? user.balance : MockERC20(tokenOut).balanceOf(user);
    }

    /// Buys exactly `amountOut` with twice the quoted input as the cap, then checks the user paid the
    /// quote, got the exact output and was refunded the rest.
    function _buyExact(address tokenIn, address tokenOut, Hop[] memory p, uint256 amountOut)
        internal
        returns (uint256 q)
    {
        q = _quoteOut(tokenIn, p, amountOut);
        assertGt(q, 0, "quote");
        Balances memory before = _balances(tokenIn, tokenOut);
        uint256 spent = tokenIn == NATIVE
            ? _swapExactOutETH(tokenOut, _legs(amountOut, p), q * 2)
            : _swapExactOut(tokenIn, tokenOut, _legs(amountOut, p), q * 2);
        Balances memory afterwards = _balances(tokenIn, tokenOut);
        assertEq(spent, q, "spent = quote");
        assertEq(before.tokenIn - afterwards.tokenIn, q, "charged the quote, refunded the rest");
        assertEq(afterwards.tokenOut - before.tokenOut, amountOut, "exact output");
        _assertRouterEmpty();
    }

    /*//////////////////////////////////////////////////////////////
                              SINGLE HOPS
    //////////////////////////////////////////////////////////////*/

    function test_v3() public {
        _buyExact(address(usdg), address(nvda), _path(_hopV3(address(nvda), 500)), 1_000e18);
    }

    function test_v3_zeroForOneBothWays() public {
        _buyExact(address(nvda), address(usdg), _path(_hopV3(address(usdg), 500)), 1_000e6);
    }

    function test_v4() public {
        _buyExact(address(usdg), address(nvda), _path(_hopV4(address(nvda), 3000, 60, address(0))), 1_000e18);
    }

    function test_v4_nativeIn_refundsETH() public {
        _buyExact(NATIVE, address(meme), _path(_hopV4(address(meme), 3000, 60, address(0))), 1 ether);
    }

    function test_v4_nativeOut() public {
        _buyExact(address(meme), NATIVE, _path(_hopV4(NATIVE, 3000, 60, address(0))), 1 ether);
    }

    function test_wrapThenV3() public {
        _buyExact(NATIVE, address(meme), _path(_hopWrap(address(weth)), _hopV3(address(meme), 10000)), 3 ether);
    }

    function test_v3ThenUnwrap() public {
        _buyExact(address(meme), NATIVE, _path(_hopV3(address(weth), 10000), _hopUnwrap()), 3 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        MULTI-HOP, EVERY NESTING
    //////////////////////////////////////////////////////////////*/

    /// v3 callbacks nested two deep, inside a v4 unlock.
    function test_v3_v3_v4() public {
        Hop[] memory p =
            _path(_hopV3(address(nvda), 500), _hopV3(address(tsla), 3000), _hopV4(address(meme), 3000, 60, address(0)));
        (uint256 q, uint256[] memory hopIn) = quoter.quotePathExactOut(address(usdg), p, 500e18);
        assertEq(hopIn[0], q);
        assertGt(hopIn[1], hopIn[2]);
        _buyExact(address(usdg), address(meme), p, 500e18);
    }

    /// A v4 hop opened from inside a v3 callback.
    function test_v4_v3() public {
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, address(0)), _hopV3(address(nvda), 3000));
        _buyExact(address(meme), address(nvda), p, 100e18);
    }

    /// v4, then v3 inside the unlock, then v4 again from the v3 callback without a second unlock.
    function test_v4_v3_v4() public {
        Hop[] memory p = _path(
            _hopV4(address(tsla), 3000, 60, address(0)),
            _hopV3(address(nvda), 3000),
            _hopV4(address(usdg), 3000, 60, address(0))
        );
        _buyExact(address(meme), address(usdg), p, 100e6);
    }

    function test_v4_v4_nativeIn() public {
        Hop[] memory p = _path(_hopV4(address(meme), 3000, 60, address(0)), _hopV4(address(tsla), 3000, 60, address(0)));
        _buyExact(NATIVE, address(tsla), p, 0.5 ether);
    }

    function test_v4Native_wrap_v3() public {
        // MEME -v4-> ETH -> WETH -v3-> USDG
        Hop[] memory p =
            _path(_hopV4(NATIVE, 3000, 60, address(0)), _hopWrap(address(weth)), _hopV3(address(usdg), 500));
        _buyExact(address(meme), address(usdg), p, 1e6);
    }

    function test_fourHops() public {
        // USDG -v3-> WETH -v3-> MEME -v4-> TSLA -v3-> NVDA
        Hop[] memory p = new Hop[](4);
        p[0] = _hopV3(address(weth), 500);
        p[1] = _hopV3(address(meme), 10000);
        p[2] = _hopV4(address(tsla), 3000, 60, address(0));
        p[3] = _hopV3(address(nvda), 3000);
        _buyExact(address(usdg), address(nvda), p, 10e18);
    }

    /*//////////////////////////////////////////////////////////////
                                 SPLITS
    //////////////////////////////////////////////////////////////*/

    function test_split_threeVenues() public {
        uint256 amount = 3e23;
        Hop[] memory a = _path(_hopV3(address(nvda), 500));
        Hop[] memory b = _path(_hopV3(address(nvda), 3000));
        Hop[] memory c = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        uint256 single = _quoteOut(address(usdg), a, amount);
        uint256 q = _quoteOut(address(usdg), a, amount * 6 / 10) + _quoteOut(address(usdg), b, amount / 10)
            + _quoteOut(address(usdg), c, amount - amount * 6 / 10 - amount / 10);

        Leg[] memory legs = new Leg[](3);
        legs[0] = Leg(amount * 6 / 10, a);
        legs[1] = Leg(amount / 10, b);
        legs[2] = Leg(amount - amount * 6 / 10 - amount / 10, c);
        uint256 before = nvda.balanceOf(user);
        uint256 spent = _swapExactOut(address(usdg), address(nvda), legs, q);
        assertEq(spent, q, "split costs the sum of independent quotes");
        assertLt(spent, single, "split is cheaper than the best single path");
        assertEq(nvda.balanceOf(user) - before, amount);
        _assertRouterEmpty();
    }

    function testFuzz_split(uint256 amount, uint8 pctA, uint16 slackBps) public {
        amount = bound(amount, 1e12, 200_000e18);
        pctA = uint8(bound(pctA, 1, 99));
        slackBps = uint16(bound(slackBps, 0, 10_000));
        uint256 outA = amount * pctA / 100;
        uint256 outB = amount - outA;
        vm.assume(outA > 0 && outB > 0);
        Hop[] memory a = _path(_hopV3(address(nvda), 500));
        Hop[] memory b = _path(_hopV4(address(nvda), 3000, 60, address(0)));
        uint256 q = _quoteOut(address(usdg), a, outA) + _quoteOut(address(usdg), b, outB);
        Leg[] memory legs = new Leg[](2);
        legs[0] = Leg(outA, a);
        legs[1] = Leg(outB, b);
        uint256 maxIn = q + q * slackBps / 10_000;
        uint256 usdgBefore = usdg.balanceOf(user);
        uint256 nvdaBefore = nvda.balanceOf(user);
        uint256 spent = _swapExactOut(address(usdg), address(nvda), legs, maxIn);
        assertEq(spent, q);
        assertEq(usdgBefore - usdg.balanceOf(user), q);
        assertEq(nvda.balanceOf(user) - nvdaBefore, amount);
        _assertRouterEmpty();
    }

    function testFuzz_roundTripWithExactInput(uint256 amountOut) public {
        amountOut = bound(amountOut, 1e6, 100_000e18);
        Hop[] memory p =
            _path(_hopV3(address(nvda), 500), _hopV3(address(tsla), 3000), _hopV4(address(meme), 3000, 60, address(0)));
        uint256 amountIn = _quoteOut(address(usdg), p, amountOut);
        assertGe(
            _quote(address(usdg), p, amountIn), amountOut, "spending the exact-output quote buys at least that much"
        );
    }

    /*//////////////////////////////////////////////////////////////
                              PROTECTIONS
    //////////////////////////////////////////////////////////////*/

    function test_revert_tooMuchRequested() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        uint256 q = _quoteOut(address(usdg), p, 1_000e18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, q, q - 1));
        router.swapExactOut(address(usdg), address(nvda), _legs(1_000e18, p), q - 1, user, block.timestamp);
    }

    function test_revert_tooMuchRequested_multiHop() public {
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, address(0)), _hopV3(address(nvda), 3000));
        uint256 q = _quoteOut(address(meme), p, 100e18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, q, q - 1));
        router.swapExactOut(address(meme), address(nvda), _legs(100e18, p), q - 1, user, block.timestamp);
    }

    function test_revert_tooMuchRequested_ignoresRouterBalance() public {
        // Tokens sitting on the router are not the caller's to spend.
        deal(address(usdg), address(router), 1_000_000e6);
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        uint256 q = _quoteOut(address(usdg), p, 1_000e18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RouterStockfill.TooMuchRequested.selector, q, 1));
        router.swapExactOut(address(usdg), address(nvda), _legs(1_000e18, p), 1, user, block.timestamp);
    }

    function test_revert_partialFill_v3() public {
        _v3Pool(address(usdg), address(tsla), 3000, PRICE_1_1, 1e6);
        Hop[] memory p = _path(_hopV3(address(tsla), 3000));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swapExactOut(address(usdg), address(tsla), _legs(1e18, p), 1e30, user, block.timestamp);
        vm.expectRevert(abi.encodeWithSignature("PartialFill(uint256)", 0));
        quoter.quotePathExactOut(address(usdg), p, 1e18);
    }

    function test_revert_partialFill_v4() public {
        _v4Pool(address(usdg), address(tsla), 500, 10, address(0), PRICE_1_1, 1e6);
        Hop[] memory p = _path(_hopV4(address(tsla), 500, 10, address(0)));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.PartialFill.selector);
        router.swapExactOut(address(usdg), address(tsla), _legs(1e18, p), 1e30, user, block.timestamp);
        vm.expectRevert(abi.encodeWithSignature("PartialFill(uint256)", 0));
        quoter.quotePathExactOut(address(usdg), p, 1e18);
    }

    function test_revert_msgValueMustEqualMax() public {
        Hop[] memory p = _path(_hopV4(address(meme), 3000, 60, address(0)));
        vm.prank(user);
        vm.expectRevert(RouterStockfill.BadValue.selector);
        router.swapExactOut{value: 1 ether}(NATIVE, address(meme), _legs(0.1 ether, p), 2 ether, user, block.timestamp);
    }

    function test_revert_feeOnTransferInput() public {
        TaxToken tax = new TaxToken();
        tax.mint(user, 1e24);
        vm.prank(user);
        tax.approve(address(router), type(uint256).max);
        vm.prank(user);
        vm.expectRevert(RouterStockfill.InputNotReceived.selector);
        router.swapExactOut(
            address(tax), address(nvda), _legs(1e18, _path(_hopV3(address(nvda), 500))), 2e18, user, block.timestamp
        );
    }

    function test_revert_expired() public {
        vm.prank(user);
        vm.expectRevert(RouterStockfill.Expired.selector);
        router.swapExactOut(
            address(usdg), address(nvda), _legs(1, _path(_hopV3(address(nvda), 500))), 1e6, user, block.timestamp - 1
        );
    }

    function test_hookTakingFee_quoteMatches() public {
        address hook = _feeHookAddress();
        _v4Pool(address(usdg), address(tsla), 3000, 60, hook, PRICE_1_1, DEEP4);
        Hop[] memory p = _path(_hopV4(address(tsla), 3000, 60, hook));
        uint256 q = _buyExact(address(usdg), address(tsla), p, 1_000e18);
        assertGt(q, _quoteOut(address(usdg), _path(_hopV4(address(nvda), 3000, 60, address(0))), 1_000e18) / 2);
    }

    function test_quoteManyExactOut() public {
        Hop[][] memory paths = new Hop[][](2);
        paths[0] = _path(_hopV3(address(nvda), 500));
        paths[1] = _path(_hopV3(address(nvda), 100));
        uint256[][] memory amounts = new uint256[][](2);
        amounts[0] = new uint256[](2);
        amounts[0][0] = 1e18;
        amounts[0][1] = 2e18;
        amounts[1] = new uint256[](1);
        amounts[1][0] = 1e18;
        uint256[][] memory ins = quoter.quoteManyExactOut(address(usdg), paths, amounts);
        assertEq(ins[0][0], _quoteOut(address(usdg), paths[0], 1e18));
        assertGt(ins[0][1], ins[0][0]);
        assertEq(ins[1][0], 0);
    }

    function test_emitsSpentAmount() public {
        Hop[] memory p = _path(_hopV3(address(nvda), 500));
        uint256 q = _quoteOut(address(usdg), p, 5e18);
        vm.expectEmit(address(router));
        emit RouterStockfill.Swapped(user, user, address(usdg), address(nvda), q, 5e18, 1);
        _swapExactOut(address(usdg), address(nvda), _legs(5e18, p), q * 3);
    }

    function test_repeatedSwaps_leaveNothingBehind() public {
        Hop[] memory buy = _path(_hopV4(address(tsla), 3000, 60, address(0)), _hopV3(address(nvda), 3000));
        Hop[] memory sell = _path(_hopV3(address(usdg), 500));
        for (uint256 i; i < 5; ++i) {
            _swapExactOut(address(meme), address(nvda), _legs(7e18 + i, buy), 1e24);
            _swapExactOut(address(nvda), address(usdg), _legs(3e6 + i, sell), 1e24);
        }
        _assertRouterEmpty();
    }
}
