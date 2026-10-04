// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IVaultPosition} from "../interfaces/IVaultPosition.sol";
import {IVaultOracle} from "../interfaces/IVaultOracle.sol";
import {IPositionManagerMinimal, IAllowanceTransfer, V4Actions} from "./IV4Periphery.sol";
import {V4PoolMath} from "./V4PoolMath.sol";

/// @title PositionStockfill
/// @notice Holds a Vault's single concentrated range in a hookless Uniswap v4 Equity Token / USDG pool
///         through the canonical PositionManager. Holds no tokens between calls.
contract PositionStockfill is IVaultPosition {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    IPositionManagerMinimal public immutable positionManager;
    IVaultOracle public immutable oracle;
    IERC20 public immutable equityToken;
    IERC20 public immutable usdg;
    bool public immutable equityIsToken0;
    uint256 private immutable equityUnit;
    address private immutable deployer;

    PoolKey private _key;
    address public vault;
    uint256 public tokenId;
    int24 public tickLower;
    int24 public tickUpper;

    error InvalidConfig();
    error Unauthorized();
    error InvalidRange();

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        IPositionManagerMinimal positionManager_,
        IAllowanceTransfer permit2,
        IVaultOracle oracle_,
        PoolKey memory key,
        IERC20 equityToken_,
        IERC20 usdg_
    ) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool equityFirst = c0 == address(equityToken_) && c1 == address(usdg_);
        if (
            (!equityFirst && !(c0 == address(usdg_) && c1 == address(equityToken_)))
                || address(key.hooks) != address(0)
        ) revert InvalidConfig();

        poolManager = poolManager_;
        positionManager = positionManager_;
        oracle = oracle_;
        equityToken = equityToken_;
        usdg = usdg_;
        equityIsToken0 = equityFirst;
        equityUnit = 10 ** IERC20Metadata(address(equityToken_)).decimals();
        deployer = msg.sender;
        _key = key;

        for (uint256 i; i < 2; ++i) {
            address token = i == 0 ? c0 : c1;
            IERC20(token).forceApprove(address(permit2), type(uint256).max);
            permit2.approve(token, address(positionManager_), type(uint160).max, type(uint48).max);
        }
    }

    function bind(address vault_) external {
        if (msg.sender != deployer || vault != address(0) || vault_ == address(0)) revert Unauthorized();
        vault = vault_;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick) {
        return V4PoolMath.slot0(poolManager, _poolId());
    }

    function liquidity() public view returns (uint128) {
        return tokenId == 0 ? 0 : positionManager.getPositionLiquidity(tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function balances() external view returns (uint256 equityAmount, uint256 usdgAmount) {
        uint128 l = liquidity();
        if (l == 0) return (0, 0);
        (uint256 a0, uint256 a1) = V4PoolMath.amountsForLiquidity(
            _oracleSqrtPrice(), TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), l
        );
        return equityIsToken0 ? (a0, a1) : (a1, a0);
    }

    function spotUsdgValue(uint256 equityAmount) external view returns (uint256) {
        (uint160 sqrtP,) = V4PoolMath.slot0(poolManager, _poolId());
        if (equityIsToken0) {
            return Math.mulDiv(Math.mulDiv(equityAmount, sqrtP, V4PoolMath.Q96), sqrtP, V4PoolMath.Q96);
        }
        return Math.mulDiv(Math.mulDiv(equityAmount, V4PoolMath.Q96, sqrtP), V4PoolMath.Q96, sqrtP);
    }

    /*//////////////////////////////////////////////////////////////
                             VAULT ACTIONS
    //////////////////////////////////////////////////////////////*/

    function enter(int24 lower, int24 upper) external onlyVault returns (uint128 added) {
        if (tokenId != 0) revert InvalidRange();
        int24 spacing = _key.tickSpacing;
        if (
            lower >= upper || lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK
                || lower % spacing != 0 || upper % spacing != 0
        ) revert InvalidRange();

        address c0 = Currency.unwrap(_key.currency0);
        address c1 = Currency.unwrap(_key.currency1);
        uint256 b0 = IERC20(c0).balanceOf(address(this));
        uint256 b1 = IERC20(c1).balanceOf(address(this));
        (uint160 sqrtP,) = V4PoolMath.slot0(poolManager, _poolId());
        added = V4PoolMath.liquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            b0 == 0 ? 0 : b0 - 1,
            b1 == 0 ? 0 : b1 - 1
        );

        if (added != 0) {
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(
                _key, lower, upper, uint256(added), uint128(b0), uint128(b1), address(this), bytes("")
            );
            params[1] = abi.encode(_key.currency0, _key.currency1);
            uint256 id = positionManager.nextTokenId();
            _modify(abi.encodePacked(V4Actions.MINT_POSITION, V4Actions.SETTLE_PAIR), params);
            tokenId = id;
            tickLower = lower;
            tickUpper = upper;
        }
        _sendToVault();
    }

    function exitAll() external onlyVault returns (uint256 equityAmount, uint256 usdgAmount) {
        if (tokenId == 0) return (0, 0);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(_key.currency0, _key.currency1, address(this));
        _modify(abi.encodePacked(V4Actions.BURN_POSITION, V4Actions.TAKE_PAIR), params);
        tokenId = 0;
        return _sendToVault();
    }

    function withdrawPortion(uint256 numerator, uint256 denominator)
        external
        onlyVault
        returns (uint256 equityAmount, uint256 usdgAmount)
    {
        uint128 l = liquidity();
        if (l == 0 || numerator == 0 || denominator == 0) return (0, 0);
        uint256 remove = numerator >= denominator ? l : Math.mulDiv(l, numerator, denominator);
        if (remove == 0) return (0, 0);
        _decrease(remove);
        return _sendToVault();
    }

    function collectFees() external onlyVault returns (uint256 equityFees, uint256 usdgFees) {
        if (tokenId == 0) return (0, 0);
        _decrease(0);
        return _sendToVault();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _decrease(uint256 amount) private {
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, amount, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(_key.currency0, _key.currency1, address(this));
        _modify(abi.encodePacked(V4Actions.DECREASE_LIQUIDITY, V4Actions.TAKE_PAIR), params);
    }

    function _modify(bytes memory actions, bytes[] memory params) private {
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    function _sendToVault() private returns (uint256 equityAmount, uint256 usdgAmount) {
        equityAmount = equityToken.balanceOf(address(this));
        usdgAmount = usdg.balanceOf(address(this));
        if (equityAmount != 0) equityToken.safeTransfer(vault, equityAmount);
        if (usdgAmount != 0) usdg.safeTransfer(vault, usdgAmount);
    }

    function _poolId() private view returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(_key)));
    }

    function _oracleSqrtPrice() private view returns (uint160) {
        uint256 usdgPerUnit = oracle.usdgValue(address(equityToken), equityUnit);
        return equityIsToken0
            ? V4PoolMath.sqrtPriceFromAmounts(equityUnit, usdgPerUnit)
            : V4PoolMath.sqrtPriceFromAmounts(usdgPerUnit, equityUnit);
    }
}
