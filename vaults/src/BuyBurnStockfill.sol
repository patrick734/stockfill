// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title BuyBurnStockfill
/// @notice Spends protocol fees on $FILL and burns every $FILL it holds.
/// @dev There is deliberately no withdrawal or rescue path: assets leave only as burned $FILL.
///      Keeper runs are capped per input token and rate-limited, bounding what a bad quote can lose.
///      If deployed before $FILL exists, `fillTokenSetter` sets the token once and it is permanent
///      from then on. Until then fees accumulate here and `drawdown` reverts.
contract BuyBurnStockfill is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice The token bought and burned. Fixed at deployment or set once later.
    ERC20Burnable public fillToken;
    /// @notice The only address that may set `fillToken`, and only while it is unset. Zero when the token
    ///         was fixed at deployment.
    address public immutable fillTokenSetter;
    ISwapAdapter public immutable swapAdapter;

    uint32 public minInterval;
    uint64 public lastDrawdown;
    bool public halted;
    uint256 public totalRetired;
    mapping(address token => uint256) public maxInputPerRun;
    mapping(address token => uint256) public totalSpent;

    event Drawdown(address indexed tokenIn, uint256 amountIn, uint256 fillOut);
    event Retired(uint256 amount, uint256 totalRetired);
    event InputLimitSet(address indexed token, uint256 maxPerRun);
    event MinIntervalSet(uint32 minInterval);
    event HaltSet(bool halted);
    event FillTokenSet(address indexed token);

    error InvalidConfig();
    error Unauthorized();
    error FillTokenAlreadySet();
    error FillTokenUnset();
    error IsHalted();
    error OverLimit();
    error TooSoon();
    error SwapShortfall(uint256 received, uint256 minimum);

    /// @param fillToken_ $FILL, or zero to set it later through `setFillToken`.
    /// @param fillTokenSetter_ Who may set $FILL once when `fillToken_` is zero; ignored otherwise.
    constructor(
        ERC20Burnable fillToken_,
        ISwapAdapter swapAdapter_,
        address admin,
        address guardian,
        address keeper,
        uint32 minInterval_,
        address fillTokenSetter_
    ) {
        if (
            (address(fillToken_) == address(0) && fillTokenSetter_ == address(0))
                || address(swapAdapter_) == address(0) || admin == address(0) || guardian == address(0)
                || keeper == address(0)
        ) revert InvalidConfig();
        fillToken = fillToken_;
        fillTokenSetter = address(fillToken_) == address(0) ? fillTokenSetter_ : address(0);
        swapAdapter = swapAdapter_;
        minInterval = minInterval_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
        if (address(fillToken_) != address(0)) emit FillTokenSet(address(fillToken_));
    }

    /// @notice Sets $FILL for a deployment made before the token existed. Callable once, by `fillTokenSetter`.
    function setFillToken(ERC20Burnable token) external {
        if (msg.sender != fillTokenSetter) revert Unauthorized();
        if (address(fillToken) != address(0)) revert FillTokenAlreadySet();
        if (address(token) == address(0)) revert InvalidConfig();
        fillToken = token;
        emit FillTokenSet(address(token));
    }

    /// @notice Swaps `amountIn` of a fee token into $FILL and retires the proceeds.
    function drawdown(IERC20 tokenIn, uint256 amountIn, uint256 minFillOut, bytes calldata route)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 fillOut)
    {
        if (halted) revert IsHalted();
        ERC20Burnable vault = fillToken;
        if (address(vault) == address(0)) revert FillTokenUnset();
        if (
            address(tokenIn) == address(vault) || amountIn == 0 || minFillOut == 0
                || amountIn > maxInputPerRun[address(tokenIn)]
        ) revert OverLimit();
        if (block.timestamp < uint256(lastDrawdown) + minInterval) revert TooSoon();
        lastDrawdown = uint64(block.timestamp);

        uint256 before = vault.balanceOf(address(this));
        tokenIn.forceApprove(address(swapAdapter), amountIn);
        swapAdapter.swap(address(tokenIn), address(vault), amountIn, minFillOut, address(this), route);
        tokenIn.forceApprove(address(swapAdapter), 0);
        fillOut = vault.balanceOf(address(this)) - before;
        if (fillOut < minFillOut) revert SwapShortfall(fillOut, minFillOut);

        totalSpent[address(tokenIn)] += amountIn;
        emit Drawdown(address(tokenIn), amountIn, fillOut);
        _retire(vault.balanceOf(address(this)));
    }

    /// @notice Burns any $FILL sent here directly. Callable by anyone. Does nothing before $FILL is set.
    function retireHeld() external nonReentrant {
        if (address(fillToken) == address(0)) return;
        _retire(fillToken.balanceOf(address(this)));
    }

    function _retire(uint256 amount) private {
        if (amount == 0) return;
        fillToken.burn(amount);
        totalRetired += amount;
        emit Retired(amount, totalRetired);
    }

    function setInputLimit(address token, uint256 maxPerRun) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxInputPerRun[token] = maxPerRun;
        emit InputLimitSet(token, maxPerRun);
    }

    function setMinInterval(uint32 interval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minInterval = interval;
        emit MinIntervalSet(interval);
    }

    function halt() external onlyRole(GUARDIAN_ROLE) {
        halted = true;
        emit HaltSet(true);
    }

    function resume() external onlyRole(DEFAULT_ADMIN_ROLE) {
        halted = false;
        emit HaltSet(false);
    }
}
