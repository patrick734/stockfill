// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Prices Equity Tokens in USDG base units from independent reference feeds.
interface IVaultOracle {
    /// @notice False when the feed is stale or missing, or the sequencer is down or in its grace
    ///         window. Never reverts, so ERC-4626 `max*` views can call it.
    function isFresh(address token) external view returns (bool);

    /// @notice USDG value of `amount` of `token`. Reverts unless `isFresh(token)`.
    function usdgValue(address token, uint256 amount) external view returns (uint256);

    /// @notice Amount of `token` worth `usdgAmount`. Reverts unless `isFresh(token)`.
    function fromUsdgValue(address token, uint256 usdgAmount) external view returns (uint256);
}
