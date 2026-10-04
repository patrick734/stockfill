# Stockfill keeper

A small Node.js bot (ethers v6, CommonJS) that runs the vault protocol's routine duties in a loop:

| # | Duty | Contract call | Who may call |
|---|------|---------------|--------------|
| 1 | Keep each Vault's range around the Chainlink price | `Vault.rebalance(tickLower, tickUpper, sellUsdg, swapAmount, route)` | `KEEPER_ROLE` |
| 2 | Collect swap fees | `Vault.harvest()` | anyone |
| 3 | Claim Credit Line reserves | `BorrowDesk.claimReserves()` | anyone |
| 4 | Forward the protocol share | `FeeRouter.routeMany(tokens)` | anyone |
| 5 | Buy and burn $FILL | `BuyBurn.drawdown(tokenIn, amountIn, minFillOut, route)` | `KEEPER_ROLE` |

Contract names are shortened here: `Vault` is VaultStockfill, `BorrowDesk` is BorrowDeskStockfill, `FeeRouter` is
FeeRouterStockfill, `BuyBurn` is BuyBurnStockfill, `VaultOracle` is OracleStockfill, `VaultPositionV4` is
PositionStockfill and `V4SwapAdapter` is SwapAdapterStockfill.

Every call is simulated first (`staticCall` from the keeper address). A reverting simulation is logged and skipped, so one failing Vault or token never stops the rest of the cycle.

The keeper does **not** liquidate borrowers and does **not** run BasketProgram `allocate`/`deallocate` (see [Not automated](#not-automated)).

## Setup

Compile the contracts first; the keeper reads its ABIs from `vaults/artifacts`:

```bash
cd vaults && npm install && npx hardhat compile
cd ../keeper && npm install
```

**ABIs** come from `vaults/artifacts` (the Hardhat build output). That keeps the keeper in lockstep with the Solidity source and covers SwapAdapterStockfill, which `web/src/generated/vaults/abis.ts` does not export. Run `npx hardhat compile` again after contract changes. If you ship the keeper without the `vaults/` folder, copy `vaults/artifacts` next to it and point `KEEPER_ARTIFACTS_DIR` at the copy.

**Addresses** come from `vaults/deployments/<KEEPER_NETWORK>.json`, written by `vaults/scripts/deploy.js`. The keeper checks that the RPC's chainId matches the file.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | none | Keeper wallet key (hex, with or without `0x`). Only read from the environment, never logged. Required when `DRY_RUN=0`. |
| `DRY_RUN` | dry run | **Only `DRY_RUN=0` sends transactions.** Any other value simulates every call and logs what it would send. |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | JSON-RPC endpoint. |
| `KEEPER_NETWORK` | `robinhood` | Picks `vaults/deployments/<name>.json`. |
| `KEEPER_ADDRESS` | `roles.keeper` from the deployment | Address to simulate from in a dry run without a key. |
| `KEEPER_CONFIG` | none | JSON file deep-merged over `config.json`. |
| `KEEPER_STATE_FILE` | none | File that keeps harvest and claim times and the borrower scan position between runs. Only live runs write it. |
| `LOOP_INTERVAL_SECONDS` | `loopIntervalSeconds` in config | Seconds between cycles. |
| `LOG_JSON` | off | `1` prints one JSON object per line instead of text. |
| `LOG_LEVEL` | `info` | `debug` shows extra detail (for example harvest interval skips). |
| `KEEPER_DEPLOYMENTS_DIR`, `KEEPER_ARTIFACTS_DIR` | `vaults/deployments`, `vaults/artifacts` | Where deployments and ABIs are read from. |

## Running

Dry run against mainnet. No key is needed; calls are simulated from `roles.keeper`:

```bash
node src/index.js --once
```

Live, looping every `loopIntervalSeconds`:

```bash
DRY_RUN=0 KEEPER_PRIVATE_KEY=0x... npm start
```

**Recommended:** run it on GitHub Actions (`.github/workflows/vault-keeper.yml`). The key lives only in the repository
secret `KEEPER_PRIVATE_KEY`, created by `node tools/wallet.js keeper-secret <owner/repo>`. The workflow runs one cycle
about every 15 minutes, keeps harvest and claim times between runs, and stays in dry-run mode until the repository
variable `KEEPER_LIVE` is `1`.

`--once` (or `KEEPER_ONCE=1`) runs one cycle and exits with status 0, which also suits cron or a systemd timer. `SIGINT`/`SIGTERM` stop the loop after the current step.

### As a background service

Keep the key in a root-only env file (`chmod 600`), not in the unit or the repo. `/etc/stockfill/keeper.env` holds
`KEEPER_PRIVATE_KEY=...`, `DRY_RUN=0` and `RPC_URL=...`.

**systemd** (`/etc/systemd/system/stockfill-keeper.service`):

```ini
[Unit]
Description=Stockfill keeper
After=network-online.target

[Service]
WorkingDirectory=/opt/stockfill/keeper
EnvironmentFile=/etc/stockfill/keeper.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30
User=stockfill

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now stockfill-keeper && journalctl -u stockfill-keeper -f
```

**pm2**: `pm2 start src/index.js --name stockfill-keeper` with the variables exported in that shell (or an ecosystem file outside the repo), then `pm2 save`.

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `loopIntervalSeconds` | 300 | Pause between cycles. |
| `txConfirmations`, `txTimeoutSeconds` | 1, 180 | How long to wait for each transaction. |
| `vaults.only` | `[]` (all) | Restrict to these tickers. |
| `rebalance.halfWidthTicks` | 1200 | The new range spans about this many ticks (about 12.7%) on each side of the oracle price, snapped outward to the pool's tick spacing. |
| `rebalance.edgeThresholdPct` | 15 | Rebalance when the pool tick is within this % of the range width from either edge, or outside it. |
| `rebalance.maxIdlePct` | 25 | Also rebalance when USDG or equity sitting idle in the Vault (new deposits, for example, which are not placed automatically) exceeds this % of Held Value. `0` disables. |
| `rebalance.minIdleUsdg` | 10 | Ignore idle value below this. |
| `rebalance.minSwapUsdg` | 5 | Skip the pre-rebalance swap when smaller than this. |
| `rebalance.routes` | `{}` | Per ticker, a hop list written from USDG to the equity token (reversed for equity sales). Empty means the adapter's registered direct pool. |
| `harvest.intervalSeconds` | 21600 | Minimum time between harvests of one Vault. |
| `harvest.minFeesUsdg` | 0 | Wait until pending fees are worth at least this. |
| `feeRouter.enabled` | true | Route every non-zero fee token each cycle. |
| `drawdown.slippageBps` | 200 | `minFillOut = quote * (10000 - slippageBps) / 10000`. |
| `drawdown.defaultRoute` | `["IN","USDG","ETH","FILL"]` | Hop list for every fee token (see below). |
| `drawdown.routes` | `{}` | Per-token override, keyed by ticker (`"META"`), `"USDG"` or token address. |
| `borrowDesk.claimReserves` | true | Call `claimReserves()` every `claimIntervalSeconds` (86400). |
| `borrowDesk.logUnhealthy` | false | Scan `Borrowed` events from `scanFromBlock` in `scanChunkBlocks` chunks and warn about accounts with health factor < 1. Set `scanFromBlock` to the BorrowDesk deploy block before enabling on mainnet. |

**Route hops** are addresses or names: `IN` (the token being sold), `USDG`, `ETH`/`NATIVE` (address(0), native ETH in Uniswap v4), `FILL`, or a Vault ticker such as `META`. Consecutive duplicates collapse, so the default route resolves to `[USDG, ETH, FILL]` for USDG and `[META, USDG, ETH, FILL]` for META. `"default"` or `[]` sends an empty route (`0x`), which makes the swap adapter use its registered direct pool (or two hops via USDG). A route is sent as `abi.encode(address[])`, the format `V4SwapAdapter.swap` decodes.

## What each duty does

### 1. Rebalance (per Vault, needs `KEEPER_ROLE`)

Skipped (and logged) when the Vault is paused, the keeper lacks the role, or the position is a mock without v4 views. Otherwise:

1. If `Vault.priceFresh()` is false, the keeper **logs and skips**. This is normal outside US market hours and on weekends: the Chainlink equity feeds stop and `rebalance` would revert `Unpriced`.
2. Pool vs oracle: `VaultPositionV4.spotUsdgValue(1 unit)` vs `VaultOracle.usdgValue(1 unit)`. If the gap is above `Vault.maxPoolDeviationBps` (default 2%), `rebalance` would revert `PoolDeviation`, so the keeper logs a warning and skips. It cannot fix this itself: the pool must be arbitraged back.
3. Trigger: no active range with value to place, pool tick outside the range or within `edgeThresholdPct` of an edge, or idle balance above `maxIdlePct`. If the oracle-centred range equals the current range, it skips rather than churning.
4. New range: centred on the oracle price's tick, ±`halfWidthTicks`, aligned to the pool's `tickSpacing`.
5. Swap size: the value split the new range needs at the pool price, from `Vault.holdings()` valued by the oracle. `Vault` enforces `maxSwapLossBps` (default 1%) against the oracle on that swap, so the keeper simulates the full swap, then 1/2, 1/4 and finally no swap, and sends the first size that passes.

`rebalance` harvests first, so the harvest timer resets.

### 2. Harvest (per Vault)

There is no pending-fee view, so the keeper simulates `position.collectFees()` as the Vault (an `eth_call` with `from = Vault`), which returns exactly what `harvest()` would collect. It harvests when that is non-zero (and above `minFeesUsdg`), at most once per `intervalSeconds`. If the simulation fails it harvests unconditionally on the interval.

### 3. BorrowDesk reserves

`claimReserves()` accrues interest and sends reserves to the FeeRouter. A `ZeroAmount` revert means nothing has built up yet; it is logged at info level.

### 4. FeeRouter

Checks the router's balance of USDG and of every Vault's Equity Token and calls `routeMany` with the non-zero ones. Runs after harvests and reserve claims so the same cycle forwards them.

### 5. Buy and burn (needs `KEEPER_ROLE`)

- Skips while `halted()`, and while `block.timestamp < lastDrawdown + minInterval`. **`lastDrawdown` is shared by every input token**, so only one drawdown can happen per `minInterval` (1 hour at launch) in total.
- Candidates: every fee token BuyBurn holds with a non-zero `maxInputPerRun`, sized `min(balance, maxInputPerRun)`, largest oracle value first. A held token with no input limit is logged as a governance to-do.
- Quote: `drawdown.staticCall(token, amount, 1, route)` from the keeper returns the $FILL the real swap delivers, and `minFillOut` is that quote less `slippageBps`. The keeper then sends `drawdown(token, amount, minFillOut, route)`. If a token's quote reverts, it logs the reason and tries the next one.
- Until $FILL is set on BuyBurn (`./set-token.sh`), the keeper logs `$FILL not set yet` and skips the step.

> **$FILL on Pons.** $FILL trades in a Uniswap v4 pool paired with **native ETH** behind the **Pons launchpad hook**. The swap adapter allows that hook and the ETH hop, and the deploy script registers the ETH/USDG leg, but the $FILL/ETH pool itself only exists once $FILL graduates on Pons. Until it is registered (`./govern.sh register-pool`, which uses `vaults/scripts/register-fill-pool.js`), the quote for the default route reverts with `InvalidRoute()`, and the keeper logs `quote failed, skipping this token` on each cycle and carries on; nothing is sent. Once the pool is registered, drawdowns start on the next cycle without keeper changes. Pons pools are small at graduation, so keep `BuyBurn.maxInputPerRun` modest: on a fork, a 500 USDG buy moved a fresh Pons pool about 23% off spot.

## Not automated

- **Liquidations.** The keeper only reports unhealthy accounts (`borrowDesk.logUnhealthy`). Liquidating needs USDG inventory and a plan for the seized Vault shares; do it manually (`BorrowDesk.liquidate`).
- **BasketProgram `allocate` / `deallocate`.** How much of the Basket goes into which Vault is a governance decision, not a routine duty. A duty can be added here once there is a policy (target weights, rebalance bands) to encode.
- **Timelock and governance actions** (input limits, risk limits, unpausing). The keeper warns when it sees one is needed (for example `maxInputPerRun` is 0 for a held token).

## Testing

Offline unit tests for tick math, rebalance planning, routes and revert decoding:

```bash
npm test
```

End to end, against a local Hardhat node running the mock demo deploy. The node uses port 8547 so it does not clash with a node on 8545. In one terminal, from the repository root:

```bash
cd vaults && npx hardhat node --port 8547
```

In a second terminal, deploy the demo (it writes `vaults/deployments/keeper.json`) and run the smoke test:

```bash
cd vaults && npx hardhat run scripts/deploy.js --network keeper
cd ../keeper && npm run smoke
```

`npm run smoke` accrues fees on the mock positions, gives the mock swap venue $FILL and opens a borrow so reserves build. It then runs the keeper with `DRY_RUN=1` (asserts nothing changed) and `DRY_RUN=0` (asserts every Vault harvested, reserves claimed, FeeRouter emptied, $FILL retired, exactly one drawdown per interval, the key never printed), plus a rate-limit rerun, a next-interval drawdown and an unhealthy-account report. It refuses to run on anything but chainId 31337 and uses Hardhat's public dev account #3 (the local keeper). Delete `vaults/deployments/keeper.json` afterwards if you do not want it around.

The local demo uses `MockPosition`, which has no Uniswap v4 views, so rebalancing is covered by the unit tests only. Try it on a mainnet fork or a testnet deployment with `DRY_RUN` before going live.

## Safety notes

- The default is a dry run. Nothing is sent unless `DRY_RUN=0` is set explicitly.
- The keeper key only holds `KEEPER_ROLE` (rebalance, drawdown) plus gas money. Keep little ETH on it. On-chain limits bound what a compromised keeper can do: registered pools only, `maxSwapLossBps` on rebalances, `maxInputPerRun` and `minInterval` on drawdowns, and the guardian can pause Vaults and halt drawdowns.
- The key is read only from `KEEPER_PRIVATE_KEY` and never logged. Credentials in the RPC URL (`https://user:pass@...`) are masked in the startup log, but prefer a URL without secrets in it.
- `minFillOut` comes from a simulation in the same block the transaction is built in, so it protects against the price moving before inclusion, not against a pool that is already manipulated. `maxInputPerRun` is the real bound on drawdown losses; keep it small relative to the $FILL pool's depth.
- Stale prices on weekends are expected and logged at info level; persistent `PoolDeviation` or quote failures during market hours are worth an alert.
- Nonces are managed locally (ethers `NonceManager`) and resynced after any failed send. Run only one live keeper per key.
