# Stockfill risk review

> Inherited from Stonkwell (MIT-licensed), on which Stockfill is based. Names were updated for Stockfill; the logic described is unchanged.

This is an internal pre-audit note. It covers the three areas in the brief (oracle staleness, pause and guardian permissions, collateral valuation) and other risks found while building. It is **not** a substitute for an independent audit.

## 1. Oracle staleness

**Facts.** Robinhood Chain Equity Token feeds are Chainlink, 8 decimals, with a 24-hour heartbeat and 0.5% deviation. They follow a 24/5 schedule: they stop updating over weekends and US market holidays. The feed already includes the token's `uiMultiplier`. No L2 sequencer-uptime feed has been published for chain 4663. USDG has its own USD feed.

**Controls in `OracleStockfill`:**
- `answer > 0`, `updatedAt <= now`, and `now - updatedAt <= maxAge` for both the Equity Token feed and the USDG feed.
- Prices are converted through USDG/USD, so a USDG depeg is priced in rather than assumed away.
- `oraclePaused()` on the Equity Token (the issuer's corporate-action flag) makes the price unusable. For example, a split is not priced at the stale pre-split value.
- An optional sequencer-uptime check with a 1-hour grace period, which the owner can set once Chainlink publishes a feed.
- `isFresh()` never reverts, so views and UIs degrade gracefully.

**What stale means for users.** Depositing, USDG exits, rebalances, borrowing and liquidation all revert. `redeemInKind` and `repay` always work, so users are never locked in.

**Residual risks and tradeoffs:**
- **`maxAge` = 26 hours** (heartbeat plus 2 hours). Tighter blocks everything during quiet sessions; looser admits older prices. Within the window, a price can be up to 26 hours old while the real market has moved. The 0.5% deviation trigger bounds this during market hours, but not across a closure.
- **Weekend gap.** A feed updated Friday at 16:00 ET goes stale around Saturday 18:00. Between the close and staleness, the pool can trade on news while the oracle cannot. `maxPoolDeviationBps` (2%) makes deposits and rebalances revert once the pool drifts, which protects the Vault from entering at a bad price.
- **No sequencer feed.** If the sequencer halts and restarts, the first blocks may carry stale prices that `maxAge` still accepts. **Action:** set the sequencer feed as soon as it exists. Until then, the guardian should pause during any announced chain incident.
- **For comparison:** TickerSpring's valuation contract (`0x6655…207E`) is unverified, so none of these checks can be confirmed there.

## 2. Pause and guardian permissions

**For comparison:** TickerSpring's admin and treasury are the same single EOA. `setFeeRecipients` takes effect instantly, and the "buyback" recipient is an EOA that has never held the token.

**Stockfill permissions:**

| Role | Holder | Can | Cannot |
|---|---|---|---|
| Admin (`DEFAULT_ADMIN_ROLE` / owner) | `TimelockController`, 48h, proposer/executor = admin multisig | Unpause; raise caps; set fee share (at most 30%) and risk limits (within hard maxima); list pools; set feeds; change the FeeRouter destination (plus a separate 48h) | Bypass the delay. Take funds: no contract has a sweep or withdraw function for user assets |
| Guardian | Separate multisig; the constructor enforces guardian ≠ admin | Pause depositing, rebalances and borrowing; lower Held Value and Credit Line caps; halt drawdowns | Unpause, raise anything, move funds, or block exits |
| Keeper | Hot EOA | `rebalance` within oracle deviation and swap-loss limits; `drawdown` within per-token run limits and minimum interval | Choose unregistered pools, exceed `maxSwapLossBps`, or set `minFillOut = 0` |

**Residual risks:**
- **Keeper griefing.** A compromised keeper can churn rebalances. Each one costs up to `maxSwapLossBps` (1% by default, 3% hard cap) of the swapped amount. Mitigation: the guardian pauses and the admin rotates the keeper. Recommended: add a keeper rate limit or TWAP-based range validation in v2.
- **Oracle owner.** Setting feeds is an admin action under the 48h timelock. A malicious feed would be visible for 48 hours before it takes effect.
- **Ownership acceptance.** After deploy, the oracle, registry and swap adapter wait for the timelock to call `acceptOwnership()`. The deploy script prints the list. Until the timelock accepts, the deployer key can still reclaim or reassign ownership, so it must be retired immediately.

## 3. Collateral valuation (Borrow Desk)

- **Oracle only.** Vault shares are valued as `convertToAssets(shares)`. `totalAssets` prices the position's principal at the oracle-implied sqrtPrice, not at pool spot, so a flash-loan move of the v4 pool does not change collateral value.
- **Haircuts.** The META Credit Line launches with a 40% maximum LTV, a 55% liquidation threshold, a 6% bonus and a 50% close factor. A position opened at maximum LTV survives a roughly 27% fall in the collateral price before it can be liquidated.
- **Monday-open gap.** Liquidation needs a fresh price, so liquidations wait over weekends and the first fresh print can already be past the threshold. Bad debt is written off if collateral hits zero: first against the Credit Line's reserves (which were booked on the same uncollected interest), then pro rata against lenders. The conservative LTV and the concentration cap (`maxCollateralShareBps` = 30% of a Vault's supply per Credit Line) bound this.
- **Liquidity of collateral.** Liquidators receive Vault shares, not USDG. When feeds are stale they can still `redeemInKind` and sell the Equity Token elsewhere, so the liquidation path does not depend on the Vault's USDG exit.
- **Reflexivity.** Large liquidations followed by USDG exits sell Equity Token into the same pool. The concentration cap and per-Vault Held Value caps limit how large this can get.

## 4. Other findings

| Risk | Status |
|---|---|
| **Swap-loss socialization.** USDG exits sell Equity Token; the cost is charged to the exiter, since shares are burned at the oracle value while the swap cost comes from the payout | Mitigated. The exiter bears their own slippage, bounded by `maxSwapLossBps` |
| **Fee-trap pools.** Many Robinhood Chain v4 pools carry hooks or extreme fees | Mitigated. Only hookless, owner-registered pools; `PositionStockfill` rejects hooks |
| **Thin or broken pools.** The live probe found CRCL 3000/60 with zero liquidity and a broken MSTR pool | Not launched. Launch Vaults are TSLA, NVDA, AAPL, PLTR and META, all within about 120 bps of the oracle |
| **Share-inflation / donation attack on the first deposit** | Mitigated. `_decimalsOffset = 6`; seeding each Vault is recommended |
| **Keeper MEV on rebalance swaps** | Bounded by the oracle `minOut`. Recommend submitting through a private RPC if one exists on the chain |
| **Position stuck** (for example PositionManager paused or broken) | `redeemInKind` still returns idle balances; position principal would need a governance migration. Recommend adding a timelocked `migratePosition` in v2 |
| **$FILL drawdown before a $FILL pool exists** | `BuyBurnStockfill` holds inputs until a $FILL/USDG pool is registered on the swap adapter. Nothing can leave except as burned $FILL |
| **Third-party code** | OpenZeppelin 5.1 and only the MIT-licensed files of Uniswap v4-core. BUSL files were not copied |

## Before mainnet
1. Get an independent audit of `VaultStockfill`, `PositionStockfill`, `SwapAdapterStockfill`, `OracleStockfill` and `BorrowDeskStockfill`.
2. Deploy the admin and guardian multisigs, then run `deploy.js` with `ADMIN_MULTISIG`, `GUARDIAN_MULTISIG`, `KEEPER_ADDRESS` and `TREASURY_MULTISIG` set, and have the timelock accept ownership.
3. Seed each Vault; launch with a $25k Held Value cap per Vault.
4. Create and register a $FILL/USDG pool and set drawdown input limits.
5. Set the sequencer-uptime feed once Chainlink publishes one.
6. Complete a legal review before opening to the public.
