// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Swap venue for Vaults and BuyBurn.
/// @dev Not trusted to report amounts: callers enforce their own minimum output and measure the
///      balance they actually received.
interface ISwapAdapter {
    /// @notice Pulls `amountIn` of `tokenIn` from the caller and sends at least `minOut` of
    ///         `tokenOut` to `recipient`. An empty `route` uses the adapter's default path.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata route
    ) external returns (uint256 amountOut);
}
