# Stockfill architecture: TickerSpring mapped contract by contract

> Inherited from Stonkwell (MIT-licensed), on which Stockfill is based. Names were updated for Stockfill; the logic described is unchanged.

Stockfill provides the same product as TickerSpring: managed Equity Token / USDG liquidity, fee compounding, borrowing against positions, and a protocol share that reduces the token supply. Stonkwell describes itself as original code. TickerSpring's MIT-licensed files were read as a design reference only, and nothing was copied. TickerSpring figures come from Robinhood Chain (chainId 4663) as of September 2026.

## Contract map

| TickerSpring (on-chain) | Stockfill | What changed and why |
|---|---|---|
| `ManagedRoutedVault`, one per Stock Token (for example META `0x130e…FEbA`, AMD `0x3a2B…Fdad`). Custom `join`/`redeem`, not ERC-4626 | `VaultStockfill.sol` (ERC-4626, asset = USDG), one per Equity Token | A standard vault interface, so integrators and the Borrow Desk can price shares with `convertToAssets`. `_decimalsOffset = 6` blocks share-inflation attacks. |
| `ManagedV3Position`: a Uniswap v3 NFT, range checked against a 30-minute TWAP | `v4/PositionStockfill.sol`: a Uniswap v4 position through the canonical PositionManager `0x58da…4fA7` and Permit2 | Principal is valued at the **oracle-implied** sqrtPrice rather than pool spot, so moving the pool cannot move share value. Hooked pools are rejected. |
| Router plus Kyber aggregator, with per-swap, per-chunk and per-stage loss caps | `v4/SwapAdapterStockfill.sol`: direct PoolManager `unlock` swaps, owner-registered pools only | No external aggregator. Many chain pools are fee traps, so only allow-listed hookless pools are used. The Vault enforces an oracle `minOut` on every swap (`maxSwapLossBps`, at most 3%). |
| "Valuation" contract `0x6655…207E` (**unverified**) | `OracleStockfill.sol` | Verified in-repo: Chainlink freshness (`maxAge`), `answer > 0`, a USDG/USD feed, the Equity Token's `oraclePaused()` corporate-action flag, and an optional L2 sequencer-uptime check with a grace period. |
| `_fees()`: 10% operations, 20% "buyback", 70% depositors | `Vault.harvest()`: 70% depositors, 30% protocol share (configurable, at most 30%) | The whole protocol share goes to one on-chain destination; there is no operations cut. |
| `RecoveryEscrowFactory.payFees()` to EOAs; `setFeeRecipients` with **no timelock** | `FeeRouterStockfill.sol` | Permissionless `route()`. Changing the destination takes a 48-hour public delay and can be cancelled. |
| Buyback recipient `0x9b46…2080`: an EOA that has **never held SPRING** | `BuyBurnStockfill.sol` | Swaps inputs to $FILL and calls `burn` in the same transaction. Per-token run limits, a minimum interval, `minFillOut > 0`, and **no withdrawal path**. |
| SPRING (`PonsV2LauncherToken`, launchpad bonding curve) | `TokenStockfill.sol` ($FILL) | Fixed supply, burnable, with no owner or mint function. |
| "TickerSpring USDG Vault" lending markets (`0x203c…05F9` and others, **unverified**) | `BorrowDeskStockfill.sol`, one isolated Credit Line per Vault | ERC-4626 lender shares, a kinked rate model, LTV / liquidation threshold / bonus / close factor, a per-account concentration cap, bad-debt write-off, and reserves sent to the FeeRouter. Borrowing and liquidation need a fresh price; repaying never does. |
| Planned "Strategies" (basket, delta-neutral) | `programs/BasketStockfill.sol`, plus the Programs page | Launches **closed** (cap 0). Exits in USDG from the idle balance, or in kind as USDG plus Vault shares. |
| Admin = treasury = one EOA. Guardian/keeper roles with a 24-hour review | `TimelockController` (48h) as admin; guardian multisig; keeper EOA | The guardian can pause and **lower** caps, but cannot unpause, raise caps or move funds. Unpausing and every parameter increase go through the timelock. |
| `StagedTokenVesting` | Not included | Team vesting can use any audited vesting contract. |
| n/a | `RegistryStockfill.sol` | An on-chain list of Vaults, Credit Lines and Programs for the app and integrators. |

## Flows

**Depositing into a Vault:** the user calls `deposit(USDG)`. The Vault harvests pending fees first, checks that pool spot is within `maxPoolDeviationBps` of the oracle, and mints shares at the pre-deposit price. Deposits stay idle until the next `rebalance`.

**Rebalance (keeper):** `exitAll`, then an oracle-bounded swap to the target mix, then `enter(tickLower, tickUpper)`. It reverts if the price is stale, the pool has drifted, or the Vault is paused.

**Exits:**
- `withdraw`/`redeem` pay USDG. They pull a pro-rata slice of the position and sell Equity Token within `maxSwapLossBps`, and the exiting holder bears that cost.
- `redeemInKind` pays Equity Token plus USDG with **no price check**. It works through pauses, market closures and oracle outages.

**Fees:** Uniswap v4 fees are collected at `harvest` (also triggered by every deposit and exit). 30% goes to `FeeRouterStockfill`, then to `BuyBurnStockfill`, which swaps to $FILL and burns it. 70% stays in the Vault and raises the share value.

## Governance matrix

| Action | Who |
|---|---|
| Pause depositing, rebalances and borrowing; lower caps; halt drawdowns | Guardian multisig |
| Unpause; raise caps; change fee share or risk parameters; list pools; change fee destination (plus 48h) | Timelock (48h), proposed by the admin multisig |
| Rebalance; run drawdowns within limits | Keeper |
| `harvest`, `route`, `retireHeld`, `accrue`, `liquidate`, `redeemInKind` | Anyone |

## Deployment status
- **Mainnet fork:** all contracts are verified by the unit suite (33 tests) and by a Robinhood Chain mainnet-fork suite on the live Uniswap v4 META/USDG pool (5 tests).
- **Deploy script:** `scripts/deploy.js` has been dry-run against the fork.
- **Mainnet:** not yet deployed. It needs the multisigs, an independent audit, and, once $FILL graduates on Pons, its $FILL/ETH pool registered on the swap adapter (`scripts/register-fill-pool.js`) before drawdowns can run.
