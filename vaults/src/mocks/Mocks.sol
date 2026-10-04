// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVaultPosition} from "../interfaces/IVaultPosition.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

// Test doubles only. Never deploy to a live network.

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mirrors the Robinhood Stock Token corporate-action flag.
contract MockStockToken is MockERC20 {
    bool public oraclePaused;

    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 18) {}

    function setOraclePaused(bool paused) external {
        oraclePaused = paused;
    }
}

contract MockAggregator {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}

/// @dev Holds tokens as "the range". Principal is its balance minus fees waiting to be collected.
contract MockPosition is IVaultPosition {
    MockERC20 public immutable equity;
    MockERC20 public immutable usdg;
    uint256 private immutable equityUnit;
    address public vault;
    uint256 public spotUsdgPerUnit;
    uint256 public pendingEquityFees;
    uint256 public pendingUsdgFees;

    constructor(MockERC20 equity_, MockERC20 usdg_, uint256 spotUsdgPerUnit_) {
        equity = equity_;
        usdg = usdg_;
        equityUnit = 10 ** equity_.decimals();
        spotUsdgPerUnit = spotUsdgPerUnit_;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "only vault");
        _;
    }

    function bind(address vault_) external {
        require(vault == address(0), "bound");
        vault = vault_;
    }

    function setSpot(uint256 spot) external {
        spotUsdgPerUnit = spot;
    }

    function accrueFees(uint256 equityFees, uint256 usdgFees) external {
        equity.mint(address(this), equityFees);
        usdg.mint(address(this), usdgFees);
        pendingEquityFees += equityFees;
        pendingUsdgFees += usdgFees;
    }

    function balances() public view returns (uint256, uint256) {
        return (
            equity.balanceOf(address(this)) - pendingEquityFees,
            usdg.balanceOf(address(this)) - pendingUsdgFees
        );
    }

    function spotUsdgValue(uint256 equityAmount) external view returns (uint256) {
        return Math.mulDiv(equityAmount, spotUsdgPerUnit, equityUnit);
    }

    uint256 public entries;

    function enter(int24, int24) external onlyVault returns (uint128) {
        ++entries;
        return 1;
    }

    function exitAll() external onlyVault returns (uint256 e, uint256 u) {
        (e, u) = balances();
        equity.transfer(vault, e);
        usdg.transfer(vault, u);
    }

    function withdrawPortion(uint256 numerator, uint256 denominator) external onlyVault returns (uint256 e, uint256 u) {
        (uint256 be, uint256 bu) = balances();
        if (numerator >= denominator) numerator = denominator;
        e = Math.mulDiv(be, numerator, denominator);
        u = Math.mulDiv(bu, numerator, denominator);
        equity.transfer(vault, e);
        usdg.transfer(vault, u);
    }

    function collectFees() external onlyVault returns (uint256 e, uint256 u) {
        e = pendingEquityFees;
        u = pendingUsdgFees;
        pendingEquityFees = 0;
        pendingUsdgFees = 0;
        if (e != 0) equity.transfer(vault, e);
        if (u != 0) usdg.transfer(vault, u);
    }
}

/// @dev Swaps at a fixed rate out of its own inventory: out = in * rate / 1e18.
contract MockSwapAdapter is ISwapAdapter {
    mapping(address => mapping(address => uint256)) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 rateWad) external {
        rate[tokenIn][tokenOut] = rateWad;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = Math.mulDiv(amountIn, rate[tokenIn][tokenOut], 1e18);
        require(amountOut >= minOut, "min out");
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}
