// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {stdError} from "forge-std/StdError.sol";
import {Venues} from "./Base.t.sol";
import {RouterStockfill} from "../src/RouterStockfill.sol";
import {ISignatureTransfer, IUniswapV3Factory} from "../src/interfaces/IExternal.sol";
import {NATIVE, Hop, Leg, Trade, Permit, Permit2Transfer} from "../src/RouteTypes.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

contract RouterStockfillPermitTest is Venues {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    address signer;
    uint256 signerKey;
    Hop[] buy;

    function setUp() public override {
        super.setUp();
        (signer, signerKey) = makeAddrAndKey("signer");
        usdg.mint(signer, 1e30);
        buy.push(_hopV3(address(nvda), 500));
    }

    function _trade(bool exactOut, uint256 limit) internal view returns (Trade memory) {
        return Trade(address(usdg), address(nvda), exactOut, limit, signer, block.timestamp);
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (Permit memory p) {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, signer, address(router), value, usdg.nonces(signer), deadline));
        (p.v, p.r, p.s) =
            vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
        p.value = value;
        p.deadline = deadline;
    }

    function _permit2(address spender, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (Permit2Transfer memory p)
    {
        bytes32 tokenPermissions = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(usdg), amount));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissions, spender, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(permit2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        p = Permit2Transfer(amount, nonce, deadline, abi.encodePacked(r, s, v));
    }

    /*//////////////////////////////////////////////////////////////
                                EIP-2612
    //////////////////////////////////////////////////////////////*/

    function test_permit_exactIn_noApprovalNeeded() public {
        uint256 q = _quote(address(usdg), buy, 1_000e6);
        Permit memory p = _permit(1_000e6, block.timestamp);
        vm.prank(signer);
        (uint256 amountIn, uint256 amountOut) = router.swapWithPermit(_trade(false, q), _legs(1_000e6, buy), p);
        assertEq(amountIn, 1_000e6);
        assertEq(amountOut, q);
        assertEq(nvda.balanceOf(signer), q);
        assertEq(usdg.allowance(signer, address(router)), 0, "permit spent in full");
        _assertRouterEmpty();
    }

    function test_permit_exactOut_refundsUnspent() public {
        uint256 q = _quoteOut(address(usdg), buy, 500e18);
        uint256 maxIn = q + 50e6;
        Permit memory p = _permit(maxIn, block.timestamp);
        uint256 before = usdg.balanceOf(signer);
        vm.prank(signer);
        (uint256 amountIn, uint256 amountOut) = router.swapWithPermit(_trade(true, maxIn), _legs(500e18, buy), p);
        assertEq(amountIn, q);
        assertEq(amountOut, 500e18);
        assertEq(before - usdg.balanceOf(signer), q);
        assertEq(nvda.balanceOf(signer), 500e18);
        _assertRouterEmpty();
    }

    function test_permit_frontRun_stillSwaps() public {
        Permit memory p = _permit(1_000e6, block.timestamp);
        // Someone copies the signature from the mempool and submits it first.
        usdg.permit(signer, address(router), p.value, p.deadline, p.v, p.r, p.s);
        vm.prank(signer);
        router.swapWithPermit(_trade(false, 0), _legs(1_000e6, buy), p);
        assertGt(nvda.balanceOf(signer), 0);
    }

    function test_revert_permit_invalidSignatureWithoutAllowance() public {
        Permit memory p = _permit(1_000e6, block.timestamp);
        p.s = bytes32(uint256(p.s) ^ 1);
        vm.prank(signer);
        vm.expectRevert(stdError.arithmeticError); // the token's own allowance check, bubbled up
        router.swapWithPermit(_trade(false, 0), _legs(1_000e6, buy), p);
    }

    function test_permit_otherCaller_spendsOwnBalance() public {
        Permit memory p = _permit(1_000e6, block.timestamp);
        // The permit names the signer, but the router only ever pulls from the caller.
        vm.prank(user);
        router.swapWithPermit(
            Trade(address(usdg), address(nvda), false, 0, user, block.timestamp), _legs(1_000e6, buy), p
        );
        assertEq(usdg.balanceOf(signer), 1e30, "signer untouched");
    }

    function test_revert_permit_nativeInput() public {
        Permit memory p;
        Hop[] memory path = _path(_hopV4(address(meme), 3000, 60, address(0)));
        vm.prank(signer);
        vm.expectRevert(RouterStockfill.BadValue.selector);
        router.swapWithPermit(Trade(NATIVE, address(meme), false, 0, signer, block.timestamp), _legs(1, path), p);
    }

    /*//////////////////////////////////////////////////////////////
                                PERMIT2
    //////////////////////////////////////////////////////////////*/

    function _approvePermit2() internal {
        vm.prank(signer);
        usdg.approve(permit2, type(uint256).max);
    }

    function test_permit2_exactIn() public {
        _approvePermit2();
        uint256 q = _quote(address(usdg), buy, 1_000e6);
        Permit2Transfer memory p = _permit2(address(router), 1_000e6, 0, block.timestamp);
        vm.prank(signer);
        (uint256 amountIn, uint256 amountOut) = router.swapWithPermit2(_trade(false, q), _legs(1_000e6, buy), p);
        assertEq(amountIn, 1_000e6);
        assertEq(amountOut, q);
        assertEq(nvda.balanceOf(signer), q);
        _assertRouterEmpty();
    }

    function test_permit2_exactOut_refundsUnspent() public {
        _approvePermit2();
        uint256 q = _quoteOut(address(usdg), buy, 500e18);
        uint256 maxIn = q * 11 / 10;
        Permit2Transfer memory p = _permit2(address(router), maxIn, 7, block.timestamp);
        uint256 before = usdg.balanceOf(signer);
        vm.prank(signer);
        (uint256 amountIn,) = router.swapWithPermit2(_trade(true, maxIn), _legs(500e18, buy), p);
        assertEq(amountIn, q);
        assertEq(before - usdg.balanceOf(signer), q);
        assertEq(nvda.balanceOf(signer), 500e18);
        _assertRouterEmpty();
    }

    function test_permit2_signedAmountAbovePull() public {
        _approvePermit2();
        Permit2Transfer memory p = _permit2(address(router), 5_000e6, 1, block.timestamp);
        vm.prank(signer);
        (uint256 amountIn,) = router.swapWithPermit2(_trade(false, 0), _legs(1_000e6, buy), p);
        assertEq(amountIn, 1_000e6);
        assertEq(usdg.balanceOf(signer), 1e30 - 1_000e6);
    }

    function test_revert_permit2_replay() public {
        _approvePermit2();
        Permit2Transfer memory p = _permit2(address(router), 1_000e6, 3, block.timestamp);
        vm.startPrank(signer);
        router.swapWithPermit2(_trade(false, 0), _legs(1_000e6, buy), p);
        vm.expectRevert(abi.encodeWithSignature("InvalidNonce()"));
        router.swapWithPermit2(_trade(false, 0), _legs(1_000e6, buy), p);
        vm.stopPrank();
    }

    function test_revert_permit2_otherCaller() public {
        _approvePermit2();
        Permit2Transfer memory p = _permit2(address(router), 1_000e6, 0, block.timestamp);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("InvalidSigner()"));
        router.swapWithPermit2(
            Trade(address(usdg), address(nvda), false, 0, user, block.timestamp), _legs(1_000e6, buy), p
        );
    }

    function test_revert_permit2_signedForAnotherSpender() public {
        _approvePermit2();
        Permit2Transfer memory p = _permit2(address(0xBEEF), 1_000e6, 0, block.timestamp);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSignature("InvalidSigner()"));
        router.swapWithPermit2(_trade(false, 0), _legs(1_000e6, buy), p);
    }

    function test_revert_permit2_amountBelowPull() public {
        _approvePermit2();
        Permit2Transfer memory p = _permit2(address(router), 999e6, 0, block.timestamp);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSignature("InvalidAmount(uint256)", 999e6));
        router.swapWithPermit2(_trade(false, 0), _legs(1_000e6, buy), p);
    }

    function test_revert_permit2_expired() public {
        _approvePermit2();
        Permit2Transfer memory p = _permit2(address(router), 1_000e6, 0, block.timestamp);
        Trade memory t = _trade(false, 0);
        t.deadline = block.timestamp + 1 hours;
        vm.warp(block.timestamp + 1);
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSignature("SignatureExpired(uint256)", block.timestamp - 1));
        router.swapWithPermit2(t, _legs(1_000e6, buy), p);
    }

    function test_revert_permit2_unavailable() public {
        RouterStockfill bare =
            new RouterStockfill(IUniswapV3Factory(address(v3)), manager, address(weth), ISignatureTransfer(address(0)));
        Permit2Transfer memory p;
        vm.prank(signer);
        vm.expectRevert(RouterStockfill.Permit2Unavailable.selector);
        bare.swapWithPermit2(_trade(false, 0), _legs(1_000e6, buy), p);
    }
}
