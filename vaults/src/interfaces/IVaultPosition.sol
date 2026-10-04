// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Holds one Vault's concentrated-liquidity range in a Uniswap v4 Equity Token / USDG pool.
/// @dev Every mutating call is restricted to the bound Vault, and every token released goes to it.
///      Removing liquidity in v4 also pays out accrued fees, so the Vault must call `collectFees`
///      first in the same transaction or the fees are counted as principal.
interface IVaultPosition {
    /// @notice Principal in the range at the oracle price rather than pool spot, so a same-block
    ///         swap cannot move the Vault's share price.
    function balances() external view returns (uint256 equityAmount, uint256 usdgAmount);

    /// @notice USDG value of `equityAmount` at the pool's current spot price.
    function spotUsdgValue(uint256 equityAmount) external view returns (uint256);

    /// @notice Opens the range with tokens already transferred in; leftovers return to the Vault.
    function enter(int24 tickLower, int24 tickUpper) external returns (uint128 liquidity);

    /// @notice Closes the range and returns everything to the Vault.
    function exitAll() external returns (uint256 equityAmount, uint256 usdgAmount);

    /// @notice Removes `numerator / denominator` of the range's liquidity.
    function withdrawPortion(uint256 numerator, uint256 denominator)
        external
        returns (uint256 equityAmount, uint256 usdgAmount);

    /// @notice Collects accrued swap fees without changing liquidity.
    function collectFees() external returns (uint256 equityFees, uint256 usdgFees);
}
