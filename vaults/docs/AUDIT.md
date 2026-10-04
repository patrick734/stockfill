# Stockfill: audit-readiness package

> Inherited from Stonkwell (MIT-licensed), on which Stockfill is based. Names were updated for Stockfill; the logic described is unchanged.

Audit brief for security firms and contest platforms. All statements are from the code on `main` as of 2026-09-28; the final audit commit hash is provided at kickoff. File paths are relative to the repository root.

---

## 1. Summary

Stockfill is a managed-liquidity protocol for Robinhood Equity Tokens (tokenized US stocks) on **Robinhood Chain (chainId 4663)**. Users deposit USDG into a **Vault**, an ERC-4626 vault. There is one Vault per Equity Token. A keeper places the Vault's balances in a single concentrated range in that token's hookless Equity Token / USDG Uniswap v4 pool. The Vault values everything at the Chainlink price, never the pool spot price. When fees are harvested, up to 30% (`protocolShareBps`, capped in code) goes to a `FeeRouterStockfill`. The router forwards all of it to `BuyBurnStockfill`, which swaps it into $FILL and burns it. The rest stays in the Vault. Holders exit either in USDG, with the exiter paying their own swap loss, or **in kind** (pro-rata Equity Token + USDG, with no price check). `BorrowDeskStockfill` is an isolated ERC-4626 lending market per Vault: lenders supply USDG, and borrowers pledge Vault shares as collateral. `BasketStockfill` is an ERC-4626 fund-of-Vaults. It ships closed. Admin power sits behind a 48-hour OpenZeppelin `TimelockController`. A separate guardian can only pause or tighten limits.

**External dependencies**

| Dependency | Address (chain 4663) | Used by | Trust placed in it |
|---|---|---|---|
| Uniswap v4 `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `SwapAdapterStockfill` (unlock/swap/sync/settle/take), `PositionStockfill` (slot0 via `extsload`, slot index 6) | Correct accounting; `POOLS_SLOT = 6` must match the deployed build |
| Uniswap v4 `PositionManager` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | `PositionStockfill` (`modifyLiquidities`, `nextTokenId`, `getPositionLiquidity`) | Liveness is required for in-kind exits (see section 5, I-3) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `PositionStockfill` constructor grants max allowance to PositionManager | Canonical Permit2 |
| Chainlink Equity Token feeds (USD, 8 dec, 24h heartbeat, 24/5 schedule) | per token in `contracts/config/robinhood.json` | `OracleStockfill` | Freshness, `answer > 0` |
| Chainlink USDG/USD feed | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | `OracleStockfill` (immutable) | Every Equity price is divided by it |
| Chainlink L2 sequencer-uptime feed | none published yet (`sequencerUptimeFeed: null`) | `OracleStockfill` (optional, owner-settable, 1h grace) | Disabled until set |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) | Asset of Vault, BorrowDesk, BasketProgram | Standard ERC-20 |
| Robinhood Equity Tokens | 18 tokens in config; launch set TSLA, NVDA, AAPL, PLTR, META | Vaults | Expose `oraclePaused()` during corporate actions. `OracleStockfill` treats `true` as unpriced |
| $FILL | Launched on the Pons launchpad (pons.family), ETH-paired, exposes `burn(uint256)`. Either passed to the deploy script as `FILL_TOKEN_ADDRESS`, or, when the protocol deploys first, set once afterwards with `BuyBurn.setFillToken` (`scripts/set-fill-token.js`) | `BuyBurnStockfill` (`balanceOf`, `burn`) | Third-party token contract, out of scope. `TokenStockfill.sol` is only used if no existing token is supplied |
| Pons launchpad hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | allowlisted on the swap adapter at deploy, see section 3 | Third-party hook on the $FILL/ETH pool |

Toolchain: Solidity 0.8.26, `viaIR`, optimizer 200 runs, `evmVersion: cancun`. OpenZeppelin Contracts 5.1.0. `@uniswap/v4-core` 1.0.2, MIT-licensed files only (types, `TickMath`, `SqrtPriceMath`, interfaces).

---

## 2. Scope

nSLOC = non-blank, non-comment lines (NatSpec and `//` stripped), counted with a script over `contracts/src`.

### In scope

| File | nSLOC | Purpose |
|---|---:|---|
| `contracts/src/VaultStockfill.sol` | 308 | ERC-4626 vault per Equity Token. Oracle-priced `totalAssets`, deposit cap, pause, harvest (fee split), pool-deviation check, USDG exits with exiter-borne swap loss, `redeemInKind`, keeper `rebalance` |
| `contracts/src/BorrowDeskStockfill.sol` | 343 | Isolated Credit Line. ERC-4626 lender shares; Vault-share collateral; kinked rate model; LTV, liquidation, close factor, bonus; concentration cap; bad-debt write-off (reserves first); `claimReserves` to FeeRouter |
| `contracts/src/v4/PositionStockfill.sol` | 179 | Holds one Vault's v4 range through PositionManager and Permit2. Principal valued at the oracle-implied sqrtPrice; rejects hooked pools; Vault-only mutators; holds no tokens between calls |
| `contracts/src/v4/SwapAdapterStockfill.sol` | 116 | Exact-input swaps via `PoolManager.unlock` through owner-registered pools only; up to 3 hops; default route direct or via hub (USDG); hooks only when owner-allowlisted; native ETH only as an intermediate hop. See section 3 |
| `contracts/src/programs/BasketStockfill.sol` | 163 | ERC-4626 over up to 8 Vaults; keeper allocate/deallocate within `maxAllocationBps`; USDG exits from idle balance only; `redeemInKind` returns USDG + Vault shares |
| `contracts/src/BuyBurnStockfill.sol` | 111 | Keeper swaps fee tokens to $FILL (per-token per-run cap, min interval, `minFillOut > 0`) and burns all $FILL held; no withdrawal path. $FILL is fixed at deployment or set exactly once by `fillTokenSetter` (the deployer); until set, `drawdown` reverts `FillTokenUnset` and fees wait |
| `contracts/src/OracleStockfill.sol` | 95 | Chainlink reader: staleness, positivity, USDG/USD conversion, `oraclePaused()` corporate-action gate, optional sequencer check; `isFresh` never reverts |
| `contracts/src/FeeRouterStockfill.sol` | 61 | Permissionless `route`/`routeMany` of the full balance to BuyBurn; destination change needs propose, then 48h, then execute |
| `contracts/src/v4/V4PoolMath.sol` | 59 | slot0 via `extsload`; `sqrtPriceFromAmounts`; `amountsForLiquidity`; `liquidityForAmounts` |
| `contracts/src/RegistryStockfill.sol` | 37 | Owner-maintained list of Vaults, Credit Lines and Programs (informational only) |
| `contracts/src/v4/IV4Periphery.sol` | 17 | Minimal PositionManager/Permit2 interfaces and the `V4Actions` constants (action codes must match v4-periphery) |
| `contracts/src/TokenStockfill.sol` | 8 | Fixed-supply `ERC20Burnable`. Deployed only if `FILL_TOKEN_ADDRESS` is not set |
| `contracts/src/governance/TimelockStockfill.sol` | 2 | Imports OZ `TimelockController` so Hardhat compiles it (unmodified OZ) |
| **Total** | **1,479** | |

Interfaces without logic, listed for reference and not counted: `interfaces/ISwapAdapter.sol` (11), `IVaultOracle.sol` (6), `IVaultPosition.sol` (11), `AggregatorV3Interface.sol` (14). Their NatSpec states behavioural expectations that the implementations must meet (for example "callers must enforce their own minimum output").

The V4SwapAdapter hook allowlist and native-ETH hop (section 3) are implemented and in scope.

### Out of scope

- `contracts/src/mocks/` (test doubles)
- `contracts/scripts/` (`deploy.js`, `probe-pools.js`, `export-abis.js`). We still welcome review of the deployment ordering described in section 8.
- `contracts/test/`
- `app/` (Next.js front end), `keeper/` (off-chain keeper bot)
- Third-party contracts: Uniswap v4, Permit2, Chainlink, USDG, Equity Tokens, the Pons $FILL token and the Pons hook. The **interaction** with the Pons hook is in scope (section 3).

---

## 3. Hook allowlist and native-ETH hop in V4SwapAdapter (implemented)

> **Status: implemented** in `contracts/src/v4/SwapAdapterStockfill.sol` (`setHookAllowed`, `hookAllowed`, `_hookOk`). Unit tests: `test/unit/V4SwapAdapter.test.js`. Fork test against a live graduated Pons pool: `test/fork/PonsRoute.fork.test.js` (USDG → native ETH → Pons token, including `BuyBurn.drawdown` end to end, minOut, and revocation). Please review both the design and the code.

**Why.** $FILL is launched on the Pons launchpad (pons.family). On graduation it trades in a Uniswap v4 pool:

| PoolKey field | Value |
|---|---|
| currency0 | native ETH (`address(0)`) |
| currency1 | $FILL |
| fee | 0 |
| tickSpacing | 200 |
| hooks | Pons launchpad hook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |

Before this change, `V4SwapAdapter.setPool` rejected this key for two reasons: `currency0 == address(0)`, and `hooks != address(0)`, so the buy-and-burn had no route into $FILL.

**Design (as implemented)**

1. `setHookAllowed(address hook, bool allowed)`, `onlyOwner` (so it runs through the 48h timelock after `acceptOwnership`). It stores an allowlist and emits an event.
2. `setPool(key)` accepts `key.hooks == address(0)` **or** an allowlisted hook. All other existing checks stay.
3. A swap through a registered pool whose hook has since been revoked (`setHookAllowed(hook, false)`) reverts. Revocation takes effect at swap time; the pool does not have to be deregistered.
4. Native ETH (`address(0)`) may appear only as an **intermediate** hop in a path (for example `[USDG, ETH, FILL]` or `[EquityToken, USDG, ETH, FILL]`). It is never allowed as `tokenIn` or `tokenOut`, so the adapter never settles or takes native currency, and the existing ERC-20 `sync/transfer/settle` and `take` logic stays valid. Setting `setPool` for an ETH-paired pool requires relaxing the `c0 != address(0)` check for that case only.
5. `PositionStockfill` is **not** changed. Vault liquidity positions still reject hooked pools.

**Deployment.** `scripts/deploy.js` (live path) allowlists the Pons hook and registers the hookless ETH/USDG pool (fee 100, tickSpacing 1; the deepest of the four hookless tiers, all within 0.5% of each other in price) while the deployer still owns the adapter. The $FILL/ETH pool itself only exists after graduation and is registered with `scripts/register-fill-pool.js`, which verifies the pool is initialized with liquidity and prints the transaction (direct from the deployer before the handoff, a timelock schedule/execute pair after). The default route (`_defaultPath`) goes through the USDG hub only, so the keeper passes an explicit `route` for ETH-hop paths; `MAX_HOPS = 3` allows `[Equity, USDG, ETH, FILL]`.

**Observed on a fork (2026-09-28, APES pool as a stand-in):** 100 USDG bought ~5.5% below the pool's spot and 500 USDG ~23% below, in a pool holding ~4 ETH. Pons pools graduate with identical liquidity (~2.93e22), so price impact depends only on the run size; `BuyBurn.maxInputPerRun` is the bound and should stay small relative to the $FILL pool. The drawdown quote comes from the same pool it trades in, so it protects against movement before inclusion, not against a manipulated pool; `minFillOut` and `maxInputPerRun` are the only limits on the price paid.

**What we ask auditors to review specifically for the Pons hook**

Under v4's address-encoded permissions, the low 14 bits of `0x…F044` (`0x3044`) set `beforeInitialize`, `afterInitialize`, `afterSwap` and `afterSwapReturnDelta`. Please confirm this against the deployed bytecode. Questions:

- `afterSwapReturnDelta` lets the hook take a cut of the unspecified (output) currency on exact-input swaps. Does the `BalanceDelta` returned to the adapter reflect that cut, so `received` and the final `take` stay consistent and never over-take?
- The adapter's `PartialFill` check requires `-paid == amount` exactly. Can the hook, or a hook-held fee or a deferred state, make a hop fail this check (a DoS on drawdowns) or pass it in a way that loses value?
- Can the hook revert, pause or reprice swaps (for example anti-sniping, graduation state, admin switches), block drawdowns, or be upgraded or reconfigured by the Pons team? The adapter passes empty `hookData`.
- Can the hook re-enter the adapter or the PoolManager in a way that breaks the unlock-callback assumptions? `swap` is `nonReentrant`; `unlockCallback` checks only `msg.sender == poolManager`.
- There is no $FILL oracle, and `minFillOut` is keeper-supplied. With a fee-0 pool plus a hook-controlled fee, how cheaply can the keeper's drawdown be sandwiched? Is `maxInputPerRun` × `minInterval` a sufficient bound?
- Could ETH ever be left in the PoolManager, or owed by it, through an intermediate hop (non-zero net delta, causing `CurrencyNotSettled`)?
- Does `$FILL.burn(uint256)` on the Pons token have side effects (hooks, fees, blocklists) that break `BuyBurn._retire`?

---

## 4. Roles and trust assumptions

### Role holders (live deploy, `contracts/scripts/deploy.js`)

| Role | Holder | Notes |
|---|---|---|
| Timelock | OZ `TimelockController`, `minDelay = 172800` (48h), proposers = executors = `[ADMIN_MULTISIG]`, admin = `address(0)` (self-administered) | Proposers also get the canceller role (OZ default). Changing the delay requires a timelocked call to itself |
| `DEFAULT_ADMIN_ROLE` / `owner` | The timelock, on every contract (see handover in section 8) | |
| `GUARDIAN_ROLE` | `GUARDIAN_MULTISIG`. The deploy script requires it to differ from the admin. `VaultStockfill`, `BorrowDeskStockfill` and `BasketStockfill` constructors enforce `guardian != admin`; `BuyBurnStockfill` does not | The admin can later grant or revoke `GUARDIAN_ROLE` or `KEEPER_ROLE` (AccessControl), timelocked |
| `KEEPER_ROLE` | `KEEPER_ADDRESS` (hot EOA) on `VaultStockfill`, `BuyBurnStockfill`, `BasketStockfill` | BorrowDesk has no keeper |
| Treasury | `TREASURY_MULTISIG` | Receives the full `TokenStockfill` supply only when a fresh token is deployed. **No on-chain role** in any contract |
| Deployer | EOA from an encrypted keystore (`DEPLOYER_ACCOUNT`) | Temporary. Keeps ownership of `OracleStockfill`, `RegistryStockfill` and `SwapAdapterStockfill` until the timelock calls `acceptOwnership()` (Ownable2Step) |

### Per-contract permissions

| Contract | Timelock (admin/owner): 48h | Guardian: instant | Keeper: instant | Anyone |
|---|---|---|---|---|
| **Vault** | `unpause`; `setHeldValueCap` (unbounded); `setProtocolShareBps` (≤ 3000, harvests first); `setRiskLimits` (pool deviation 1–500 bps, swap loss 1–300 bps); grant/revoke roles | `pause` (blocks `deposit`, `mint`, `rebalance` only); `lowerHeldValueCap` (≤ current) | `rebalance(tickLower, tickUpper, sellUsdg, swapAmount, route)`: any valid tick range; swap bounded by oracle `minOut` | `deposit`, `mint`, `withdraw`, `redeem`, `redeemInKind`, `harvest` |
| **BorrowDesk** | `unpause`; `setRiskParams` (bounds in `_setRisk`); `setRateModel` (only kink bounded, rates unbounded); `setCaps` (up or down); grant/revoke roles | `pause` (blocks `deposit`, `mint`, `pledge`, `borrow`); `lowerCaps` | — | lender `withdraw`/`redeem`, `release`, `repay` (anyone's debt), `liquidate`, `accrue`, `claimReserves` |
| **BuyBurn** | `setInputLimit` (unbounded); `setMinInterval` (unbounded, can be 0); `resume`; grant/revoke roles. **Not timelocked:** `setFillToken`, callable only by the immutable `fillTokenSetter` (deployer), only while $FILL is unset | `halt` | `drawdown(tokenIn, amountIn, minFillOut, route)`: `amountIn ≤ maxInputPerRun[tokenIn]`, `minFillOut > 0`, `tokenIn != $FILL`, spacing ≥ `minInterval` | `retireHeld` |
| **FeeRouter** (Ownable2Step; owner = timelock from the constructor) | `proposeDestination` → wait `CHANGE_DELAY` (48h) → `executeDestination`; `cancelDestination`. Effective delay is 96h+ (timelock plus internal delay) | — | — | `route`, `routeMany` |
| **VaultOracle** (Ownable2Step) | `setFeed(token, aggregator, maxAge)` (any `maxAge > 0`); `setSequencerFeed` (can be set to zero to disable). `usdgFeed` and `usdgMaxAge` are immutable | — | — | views |
| **V4SwapAdapter** (Ownable2Step) | `setPool(key)` (`c0 < c1`; hook zero or allowlisted; native ETH allowed as `currency0`; overwrites the existing pair), `setHookAllowed(hook, bool)` | — | — | `swap` (anyone may swap through registered pools) |
| **BasketProgram** | `listVault` (≤ 8, same asset); `delistVault` (only if none held); `setHeldValueCap`; `setMaxAllocationBps` (1–10000); `unpause`; grant/revoke roles | `pause` (blocks `deposit`, `mint`, `allocate`); `lowerHeldValueCap` | `allocate` (listed Vaults, ceiling checked after deposit); `deallocate` | `deposit`/`mint` (cap starts at 0), `withdraw`/`redeem` (idle USDG only), `redeemInKind` |
| **VaultRegistry** (Ownable2Step) | `list`, `delist` | — | — | `entries()` |
| **VaultPositionV4** | — (no admin). `bind(vault)` once, by the deployer | — | — | views. All mutators are `onlyVault` |

### Trust assumptions

- **No role can withdraw user assets.** No contract has a sweep, rescue or arbitrary-call function. Please check this claim.
- The timelock can still hurt users within its bounds, with 48h notice:
  - repoint an oracle feed to a malicious aggregator;
  - register a bad pool on the adapter, overwriting a pair;
  - raise `maxSwapLossBps` to 3%;
  - set an extreme rate model or caps;
  - grant `KEEPER_ROLE` to an attacker.
  Users are expected to exit (in kind) during the delay.
- A compromised keeper can:
  - churn `rebalance`, losing up to `maxSwapLossBps` of the swapped amount each time;
  - place the range out of the market, so the Vault earns no fees;
  - choose a bad `minFillOut` on drawdowns, bounded by `maxInputPerRun` per `minInterval`;
  - move BasketProgram capital among listed Vaults.
  It cannot pick unregistered pools or exceed the oracle `minOut`.
- The guardian can grief only by pausing. It cannot block `withdraw`/`redeem`/`redeemInKind` on Vaults, lender exits, `repay`, `release` or `liquidate`.

---

## 5. Invariants to try to break

| # | Invariant | Where enforced |
|---|---|---|
| I-1 | A depositor or exiter cannot lower the share price at other holders' expense, beyond rounding. Deposits harvest first and mint at the pre-deposit price. On USDG exits, `_raiseUsdg` measures the drop in `totalAssets` and charges it to the exiter: extra shares in `withdraw`, a reduced payout in `redeem` | `Vault.deposit/mint/withdraw/redeem`, `_raiseUsdg` |
| I-2 | Share value can't be moved through the pool. `totalAssets` prices the position's principal at the **oracle-implied** sqrtPrice (`VaultPositionV4.balances`) and idle Equity Token at the oracle price. Pool spot is used only by `_checkPool` (deviation ≤ `maxPoolDeviationBps`) and for liquidity sizing in `enter` | `Vault.totalAssets`, `VaultPositionV4.balances/_oracleSqrtPrice` |
| I-3 | In-kind exits never need a price and are never blocked by pause or staleness. `redeemInKind` calls only `collectFees` and `withdrawPortion`, which make no oracle calls. **Caveat:** it still depends on the PositionManager and PoolManager being live, and on the Equity Token and USDG being transferable | `Vault.redeemInKind`, `BasketProgram.redeemInKind` |
| I-4 | In-kind payouts are pro-rata and round down, so remaining holders are not diluted | `Math.mulDiv` floor in both `redeemInKind` |
| I-5 | Protocol share ≤ 30% (`MAX_PROTOCOL_SHARE_BPS = 3000`). A share change harvests pending fees at the old rate first | `Vault.setProtocolShareBps` |
| I-6 | Every Vault swap receives at least oracle value × (1 − `maxSwapLossBps`), measured by balance delta. `maxSwapLossBps` ≤ 300 | `Vault._swapChecked` |
| I-7 | Oracle staleness, a missing feed, a stale USDG feed, a down sequencer or grace window, or `oraclePaused()` makes `usdgValue`/`fromUsdgValue` revert and `isFresh` return false (it never reverts). This blocks `deposit`, `mint`, `withdraw`, `redeem`, `rebalance`, `borrow`, `release`-with-debt and `liquidate` | `VaultOracle._read`, callers |
| I-8a | Once $FILL is set in `BuyBurnStockfill` it never changes; only `fillTokenSetter` can set it, once, and only when the token was not fixed at deployment | `BuyBurn.setFillToken` (`test/unit/BuyBurn.pending.test.js`) |
| I-8 | `BuyBurnStockfill` has no outflow except burned $FILL. Input tokens leave only through `swapAdapter.swap`, whose output must be $FILL ≥ `minFillOut > 0` | `BuyBurnStockfill` (no withdraw/sweep; test "exposes no withdrawal, rescue or sweep path") |
| I-9 | FeeRouter sends only to `buyBurn`, and changing it takes ≥ 48h after `proposeDestination` | `FeeRouterStockfill` |
| I-10 | BorrowDesk `reserves` ≤ backing: after a bad-debt write-off, reserves are reduced by `min(reserves, written)` first, so later lenders' deposits are never claimable as reserves. `totalAssets = cash + debt − reserves` (floored at 0) | `BorrowDesk.liquidate`, `totalAssets` (fixed in `c8dc280`) |
| I-11 | Lender withdrawals never take reserved cash: `maxWithdraw/maxRedeem` ≤ `cash − reserves` | `BorrowDesk._freeCash` |
| I-12 | After `borrow` or `release`, debt ≤ `collateralValue × ltvBps` at a fresh price | `_requireWithinLtv` |
| I-13 | Liquidation only when health factor < 1 at a fresh price. Repay ≤ close factor × debt; seized ≤ collateral. Any remaining debt when collateral reaches 0 is written off | `BorrowDesk.liquidate` |
| I-14 | Risk-parameter bounds: `0 < ltv < liqThreshold ≤ 9000`, `liqThreshold × (1 + bonus) < 100%`, `0 < closeFactor ≤ 100%`, `maxCollateralShare ≤ 100%`, `reserveFactor ≤ 50%`; `0 < kink < 1e18` | `_setRisk`, `_setRates` |
| I-15 | Total pledged shares ≤ `maxCollateralShareBps` × Vault supply, checked at pledge time only | `BorrowDesk.pledge` |
| I-16 | `repay` never needs a price and works while paused | `BorrowDesk.repay` |
| I-17 | `PositionStockfill` holds no tokens after any call; everything is swept to the Vault. Only the bound Vault can mutate it, and `bind` works once, by the deployer | `_sendToVault`, `onlyVault`, `bind` |
| I-18 | The adapter only swaps through owner-registered pools and consumes exactly `amountIn` on every hop (`PartialFill` otherwise). Callers verify output by balance delta and do not trust the return value | `V4SwapAdapter.unlockCallback`, `Vault._swapChecked`, `BuyBurn.drawdown` |
| I-19 | Guardian actions only tighten: `pause`, `halt`, `lower*Cap` (reverts if raising) | all guardian functions |
| I-20 | ERC-4626 inflation resistance: `_decimalsOffset = 6` on Vault, BorrowDesk and BasketProgram (plus seeding each Vault at launch) | `_decimalsOffset` |
| I-21 | BasketProgram per-Vault allocation ≤ `maxAllocationBps` of total assets after each `allocate` | `BasketProgram.allocate` |
| I-22 | The adapter never routes through a pool whose hook is not currently allowlisted (checked per hop at swap time, so revoking a hook blocks existing registrations), and never has native ETH as `tokenIn`/`tokenOut` | `V4SwapAdapter._hookOk`, `swap`, `unlockCallback` |

---

## 6. Known issues and accepted risks

Please do not report these as findings unless you show an impact beyond what is described.

### From recent work

| ID | Issue | Status |
|---|---|---|
| K-0 | **The deployer key can choose $FILL once.** When the protocol deploys before $FILL launches, `fillTokenSetter` (the deployer EOA) sets the token with no timelock. A compromised deployer key before that call could point buy-and-burn at a worthless token, permanently. Fees at stake are only those accumulated before the call. Mitigation: `set-fill-token.js` checks decimals and a real `burn`, and the token is set minutes after launch | Accepted; the owner deploys before the token to deny snipers a window |
| K-1 | **Buy-and-burn activates only after $FILL graduates on Pons.** The $FILL/ETH pool does not exist until then, so it cannot be registered at deploy; `drawdown` reverts (`InvalidRoute`) and fees accumulate in `BuyBurnStockfill`, which they cannot leave by any other path. Once the pool is live, `scripts/register-fill-pool.js` prints the registration transaction (deployer before the timelock handoff, timelock after). The keeper detects the revert in its quote and skips | Accepted; expected to last days |
| K-2 | **Fixed:** BorrowDesk reserves were not written down on a bad-debt write-off. Reserves booked on never-collected interest could exceed backing and be claimed out of later lenders' deposits | Fixed in `c8dc280` (`reserves -= min(reserves, written)`), with tests |
| K-3 | `VaultRegistry.delist` keeps `indexPlusOne` set, so a delisted target can never be listed again (`AlreadyListed`). `delist` does not check `listed`, so a double delist succeeds and emits `Delisted` twice | Accepted (informational registry; covered by a test) |
| K-4 | `BorrowDesk.release` with `shares > collateralShares` reverts with `ZeroAmount`, a misleading error name | Accepted (cosmetic) |
| K-5 | `BorrowDesk.claimReserves` is permissionless by design. It can only send `min(reserves, cash)` to the immutable `feeRouter` | By design |
| K-6 | `SwapAdapterStockfill` constructor has no zero-address check on `hub_` (or `poolManager_`) | Accepted (deploy-time parameter; deploy script passes config values) |
| K-7 | Slither 0.11.6 found **no high-severity true positives**. False positives and accepted items: (a) reentrancy on paths guarded by `nonReentrant` or `onlyVault`; (b) strict equality on zero checks (`== 0`); (c) intentionally unused return values where balance-delta measurement is used instead (for example `swapAdapter.swap`, `position.withdrawPortion` in `_pullUsdg`); (d) the missing zero-check in K-6 | Triaged |

### From `docs/RISK_REVIEW.md`

| ID | Risk | Mitigation or status |
|---|---|---|
| K-8 | `maxAge` = 26h (93,600 s) for Equity and USDG feeds. A price up to 26h old is accepted, and the gap across market closures is not bounded by the 0.5% deviation trigger | Accepted tradeoff. `maxPoolDeviationBps` (2%) blocks deposits and rebalances when the pool drifts |
| K-9 | Weekend and holiday gap: the pool trades while the feed is paused, and the first Monday print can already be past liquidation thresholds | Conservative LTV 40% / liquidation 55%; concentration cap 30%; bad debt isolated per Credit Line |
| K-10 | No sequencer-uptime feed exists yet for chain 4663. After a sequencer restart, stale prices within `maxAge` are accepted | `setSequencerFeed` once published; guardian pauses during chain incidents |
| K-11 | Keeper griefing: repeated rebalances each cost up to `maxSwapLossBps` of the swap | Guardian pause, keeper rotation. Rate limit or TWAP check deferred to v2 |
| K-12 | Keeper MEV on rebalance and drawdown swaps | Oracle `minOut` for Vaults. BuyBurn has no $FILL oracle: bounded by `maxInputPerRun` and `minInterval` |
| K-13 | Position stuck: if PositionManager is paused or broken, the position's principal cannot be withdrawn, and `redeemInKind` also reverts because it calls `collectFees`/`withdrawPortion` | No migration function. A timelocked `migratePosition` is proposed for v2 |
| K-14 | Before the timelock calls `acceptOwnership()`, the deployer EOA still owns `OracleStockfill`, `RegistryStockfill` and `SwapAdapterStockfill`, and can call `setFeed`/`setPool` instantly | Operational: schedule acceptance immediately and retire the key (see section 8) |
| K-15 | Reflexivity: large liquidations followed by USDG exits sell Equity Token into the same pool | Per-Vault caps ($25k at launch), concentration cap |
| K-16 | Equity Tokens are issuer debt securities. Issuer, transfer-restriction and corporate-action risk is external | `oraclePaused()` gate; out of scope |

### Other behaviour we know about

- `withdraw`/`redeem` on a Vault also revert on pool deviation (`_checkPool`), not only on staleness. `redeemInKind` is the fallback.
- `Vault.setHeldValueCap`, `BuyBurn.setInputLimit`/`setMinInterval`, `BorrowDesk.setCaps`, the BorrowDesk rate slopes and `OracleStockfill` `maxAge` have no upper bounds in code. They are timelocked only.
- `BorrowDeskStockfill` concentration cap is checked at `pledge` only. Later Vault supply decreases can push existing pledges above the ratio.
- Donations to a Vault or to BasketProgram raise the share price, which benefits holders. `VaultPositionV4.collectFees` sweeps any token balance the position contract holds, including donations, and books it as fees.
- `VaultPositionV4.enter` reverts if a position already exists. `rebalance` always calls `exitAll` first. The interface NatSpec says "opens or tops up".

---

## 7. Build and test

Requires Node.js (LTS) and npm. All commands run from `contracts/`.

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test                 # unit suite (contracts/test/unit), mocks only
npx hardhat coverage             # solidity-coverage over the unit suite
```

**Fork tests** (`contracts/test/fork/VaultV4.fork.test.js`) run against the live META/USDG v4 pool on a Robinhood Chain fork. `FORK=1` switches the test path to `test/fork`.

```bash
# bash
FORK=1 ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK=<optional block> npx hardhat test
# weekends / holidays: equity feeds stop updating, so widen the accepted age (seconds)
FORK=1 FORK_EQUITY_MAX_AGE=345600 npx hardhat test
```

```bash
FORK=1 FORK_EQUITY_MAX_AGE=345600 npx hardhat test
```

`ROBINHOOD_RPC_URL` defaults to `https://rpc.mainnet.chain.robinhood.com`. `FORK_BLOCK` pins a block.

**Deploy dry run on a fork:** `FORK=1 DEPLOY_LIVE=1 npx hardhat run scripts/deploy.js`.

### Current results (2026-09-28, commit `ada482d`)

- Unit tests: **204 passing, 0 failing** (`npx hardhat test`, about 30 s). Other work may add tests at the same time, so the count may be higher when you receive this.
- Fork tests: **5 tests**: prices META and sees a live pool; deposit and range open; fee earning and the 30% harvest; in-kind and USDG exits through the live pool; re-range with an empty position contract. They were not re-run for this document because they need network access and fresh feeds.
- Coverage (`npx hardhat coverage`, unit suite):

| File | % Stmts | % Branch | % Funcs | % Lines |
|---|---:|---:|---:|---:|
| BorrowDeskStockfill.sol | 100 | 92.14 | 100 | 100 |
| BuyBurnStockfill.sol | 100 | 92.5 | 100 | 100 |
| FeeRouterStockfill.sol | 100 | 91.67 | 100 | 100 |
| VaultStockfill.sol | 100 | 91.8 | 100 | 100 |
| OracleStockfill.sol | 100 | 100 | 100 | 100 |
| RegistryStockfill.sol | 100 | 100 | 100 | 100 |
| TokenStockfill.sol | 100 | 100 | 100 | 100 |
| BasketStockfill.sol | 100 | 92.55 | 100 | 100 |
| V4PoolMath.sol | 0 | 0 | 0 | 0 |
| SwapAdapterStockfill.sol | 0 | 0 | 0 | 0 |
| PositionStockfill.sol | 0 | 0 | 0 | 0 |

The `src/` core directory is at 100% lines and 92.97% branches. **The v4 contracts (`PositionStockfill`, `SwapAdapterStockfill`, `V4PoolMath`) are covered only by the fork tests**, which coverage does not measure. The unit suite uses `MockPosition` and `MockSwapAdapter` in their place. This is a known gap: the v4 contracts need the most manual review.

---

## 8. Deployment and launch plan

From `./launch.sh` (runs `contracts/scripts/deploy.js --network robinhood`), signing with the keystore `DEPLOYER_ACCOUNT`, with `ADMIN_MULTISIG`, `GUARDIAN_MULTISIG` (must differ from admin), `KEEPER_ADDRESS`, `TREASURY_MULTISIG`, and `FILL_TOKEN_ADDRESS` (the existing Pons $FILL; the script checks 18 decimals and that `burn(0)` does not revert).

**Script order**

1. `TimelockController(172800, [admin], [admin], address(0))`.
2. $FILL: use `FILL_TOKEN_ADDRESS`, or deploy `FairToken(treasury, 1e9 × 1e18)`.
3. `VaultOracle(owner = deployer, sequencerFeed = 0, usdgFeed, 93600, 6)`.
4. `V4SwapAdapter(owner = deployer, PoolManager, hub = USDG)`.
5. `BuyBurn(FILL, adapter, admin = deployer, guardian, keeper, minInterval = 3600)`; `setInputLimit(USDG, 5,000 USDG)`.
6. `FeeRouter(owner = timelock, BuyBurn)`.
7. `VaultRegistry(owner = deployer)`.
8. For each launch Vault (TSLA, NVDA, AAPL, PLTR, META):
   - `oracle.setFeed(token, feed, 93600)`;
   - `drawdown.setInputLimit(token, 50e18)`;
   - `adapter.setPool(hookless token/USDG key)`, with fee and tickSpacing from `config/robinhood.pools.json`;
   - deploy `PositionStockfill`;
   - deploy `VaultStockfill` (admin = timelock, cap = $25,000);
   - `position.bind(vault)`;
   - `registry.list`.
9. META `BorrowDeskStockfill` (admin = timelock). LTV 40%, liquidation threshold 55%, bonus 6%, close factor 50%, concentration 30%, reserve factor 10%. Rates: base 2%, slope1 6%, slope2 100%, kink 80%. Supply cap 10,000 USDG, borrow cap 5,000 USDG. Then `registry.list`.
10. `BasketProgram(admin = deployer, …)`; `listVault` × 5; `registry.list`. It launches closed (`heldValueCap = 0`).
11. Handover:
    - `BuyBurnStockfill` and `BasketStockfill`: `grantRole(DEFAULT_ADMIN_ROLE, timelock)`, then `renounceRole(DEFAULT_ADMIN_ROLE, deployer)`;
    - `OracleStockfill`, `RegistryStockfill` and `SwapAdapterStockfill`: `transferOwnership(timelock)`, which is pending under Ownable2Step.
12. Writes `deployments/robinhood.json` and prints the pending acceptances.

**After the script (through the timelock, 48h each)**

1. The admin multisig calls `timelock.schedule(...)` (or `scheduleBatch`) for `acceptOwnership()` on `OracleStockfill`, `RegistryStockfill` and `SwapAdapterStockfill`. After 48h, it calls `execute`. **Until then the deployer key owns these three (K-14),** so retire the key as soon as the transfers are started.
2. Seed each Vault with a small deposit, then the keeper calls the first `rebalance`.
3. **$FILL burn activation** (after $FILL graduates on Pons). The hook allowlist and the ETH/USDG leg are set by the deploy script. `scripts/register-fill-pool.js` then prints `adapter.setPool({currency0: ETH (0x0), currency1: FILL, fee: 0, tickSpacing: 200, hooks: 0xE5e7…e044})`: a direct deployer transaction before the handoff, a timelock schedule/execute pair after it.
   - The keeper then calls `drawdown(USDG, ≤ maxInputPerRun, minFillOut, abi.encode([USDG, ETH, FILL]))`, and Equity Token inputs use `[Equity, USDG, ETH, FILL]`. Until the pool is registered, its quote reverts and it skips.
4. Set the sequencer-uptime feed when Chainlink publishes one.
5. Raise caps gradually. Open BasketProgram with `setHeldValueCap` through the timelock.

---

## 9. Areas of concern (ranked)

1. **V4SwapAdapter hook allowlist and ETH hop, and the Pons hook interaction** (section 3). This is new code interacting with a third-party hook that has `afterSwapReturnDelta`, on the only path to $FILL. The drawdown path has no oracle bound.
2. **`VaultStockfill` exit accounting.** `withdraw` share math (`assets + loss` over `valueBefore`), `redeem` net payout, `_pullUsdg` sizing (`withdrawPortion(min(needed, positionValue), positionValue)`), and rounding directions. Can an exiter shift swap loss or rounding onto remaining holders, or extract value by combining `deposit` → `withdraw` / `redeemInKind` around harvests?
3. **`PositionStockfill` and `V4PoolMath`.** Oracle-implied valuation versus spot-based liquidity sizing in `enter` (`b0 - 1`, `b1 - 1`, `uint128` casts). `sqrtPriceFromAmounts` clamping and precision for 18-decimal Equity versus 6-decimal USDG in both token orders. `POOLS_SLOT` extsload correctness. Fee versus principal separation (`collectFees` before `withdrawPortion`). PositionManager action encoding.
4. **`BorrowDeskStockfill` accounting.** Interest accrual (`_projected` uses pre-accrual utilization), `debtScaled` rounding (ceil on borrow, floor on reduce, zeroing in `_reduceDebt`), liquidation seize and repay math when collateral is insufficient, the bad-debt and reserves path (K-2 fix), and whether `totalDebt` can drift from the sum of account debts.
5. **`SwapAdapterStockfill` (current code).** Unlock-callback settlement (`sync`, `transfer`, `settle`, `take`), the `PartialFill` invariant, the permissionless `swap`, pair overwrite in `setPool`, and default hub routing.
6. **`OracleStockfill`.** Scale computation in `setFeed` (`token decimals + feed decimals − usdgDecimals`), USDG conversion precision, sequencer logic (`startedAt` semantics), and whether the `oraclePaused()` staticcall can be spoofed or can grief.
7. **Liveness of the "always exit" guarantees** (I-3, I-16) under PositionManager failure, Equity Token transfer restrictions, or `oraclePaused()`.
8. **`BasketStockfill`.** Allocation ceiling check, `redeemInKind` with shares of Vaults that are paused or stale, and `delistVault` swap-and-pop.
9. Governance and deployment ordering (K-14; `BuyBurnStockfill` does not enforce guardian ≠ admin).
10. `FeeRouterStockfill`, `BuyBurnStockfill` and `RegistryStockfill` (small, fully unit-covered).

---

## 10. Contact

- Point of contact: **[Your name / Telegram / email]**
- Repository: **[repo link]** (audit commit: final hash provided at kickoff)
- Preferred report format: Markdown or PDF with severity, affected file and line, and a proof-of-concept (a Hardhat test is preferred)
- Existing docs: `README.md`, `docs/OVERVIEW.md`, `docs/ARCHITECTURE.md`, `docs/RISK_REVIEW.md`
