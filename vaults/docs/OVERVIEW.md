# Stockfill: project overview

> Inherited from Stonkwell (MIT-licensed), on which Stockfill is based. Names were updated for Stockfill; the logic described is unchanged.

## In one paragraph

Stockfill is a DeFi protocol on **Robinhood Chain** that turns tokenized stocks into a yield product. A user deposits USDG, a dollar stablecoin, into a **Vault**. There is one Vault per stock, for example the META Vault or the TSLA Vault. The Vault puts the USDG to work as liquidity in that stock's Uniswap v4 market (Equity Token / USDG) and earns fees from every trade. **70%** of those fees compound back into the Vault for its holders. The other **30%** is automatically spent buying the protocol's token, **$FILL**, which is then burned. Vault shares can also be pledged on the **Borrow Desk** to borrow USDG. Every price the protocol relies on comes from Chainlink, is checked for freshness, and is never taken from the trading pool.

---

## 1. The problem it solves

Robinhood Chain hosts **Equity Tokens**: on-chain tokens that track the prices of US stocks and ETFs such as TSLA, NVDA, AAPL and META. People trade them against USDG on Uniswap, and those trades pay fees to whoever provides liquidity.

Earning those fees yourself is hard:

- **Concentrated liquidity needs active management.** On Uniswap v4 you choose a price range. If the stock moves out of that range, you stop earning, and your position drifts entirely into one asset.
- **Stock markets close, but chains don't.** Chainlink stock prices pause at night, over weekends and on holidays, while the pool keeps trading. A naive strategy can be exploited in that gap.
- **Many pools are traps.** Robinhood Chain has pools with custom hooks or extreme fees that quietly drain anyone who routes through them.
- **The liquidity just sits there.** A raw LP position is hard to borrow against.

Stockfill packages all of this into a single deposit: **deposit USDG, hold a share, earn fees, exit whenever you want.**

---

## 2. How it works for a user

| Step | What happens |
|---|---|
| **Deposit** | Deposit USDG into, say, the META Vault. You receive Vault shares that represent your portion of the Vault's **Held Value**. |
| **The Vault works** | A keeper places the Vault's funds in a concentrated range around the Chainlink price and moves the range when the price moves. |
| **Fees compound** | Trading fees are collected on every deposit, exit and rebalance. 70% stays in the Vault, so each share is worth more over time. |
| **Borrow (optional)** | Pledge your Vault shares on the Borrow Desk and draw a USDG **Credit Line** against them. |
| **Exit** | Withdraw in USDG, or **redeem in kind** (receive the stock token and USDG directly). In-kind exits work even when markets are closed or the protocol is paused. |

### Vocabulary

| Stockfill term | Meaning |
|---|---|
| Vault (for example "AMD Vault") | A managed liquidity vault for one Equity Token / USDG pair |
| Equity Token | A tokenized stock on Robinhood Chain (legally a debt security, not a share) |
| Depositing into a Vault | Depositing USDG |
| Held Value | The total value a Vault holds, at the Chainlink price |
| Yield Rate | Recent fee income, annualized. Historical, not a forecast |
| Borrow Desk / Credit Line | Isolated USDG lending markets backed by Vault shares |
| Programs | Managed strategies built from Vaults and Credit Lines |
| Buy and burn | Using protocol fees to buy $FILL and burn it |
| $FILL | Stockfill's fixed-supply token |

---

## 3. The economic model

### Fee split

```
Trading fees earned by a Vault
 ├── 70%  → stays in the Vault (compounds for Vault holders)
 └── 30%  → FeeRouter → BuyBurn → swapped into $FILL → burned
```

- The 30% protocol share is capped **in code** at 30%. Governance can lower it but never raise it above that.
- **All** of the protocol share goes to buy and burn. No operations cut and no team wallet sits in the middle.
- The BuyBurn contract has **no withdrawal function**. Whatever it receives can only leave as burned $FILL.
- Redirecting the fee flow elsewhere requires a **public 48-hour delay**, so the community sees it coming.

### $FILL

- Fixed supply of 1,000,000,000, minted once at deployment.
- No owner and no mint function; anyone can burn their own tokens.
- Supply only goes down over time, as protocol fees retire it.
- $FILL grants no claim on profits or fees. The burn reduces supply; it does not support any price.

### Borrow Desk economics

- Lenders deposit USDG and earn a variable interest rate.
- Borrowers pay a rate set by utilization: 2% base, rising to 8% at 80% utilization, then rising steeply above that to protect lender liquidity.
- 10% of interest goes to reserves, which also flow to the FeeRouter and therefore to buy and burn.

---

## 4. The system, component by component

| Contract | Role |
|---|---|
| **Vault** | ERC-4626 vault, one per Equity Token. Holds the Chainlink-priced accounting, deposit caps, pause controls, fee harvesting and exit logic. |
| **VaultPositionV4** | Manages the Vault's Uniswap v4 liquidity position through Uniswap's official PositionManager. Rejects pools with hooks. |
| **V4SwapAdapter** | Executes swaps directly on Uniswap v4, only through pools that governance has explicitly registered. |
| **VaultOracle** | Reads Chainlink. Checks that prices are fresh and positive, converts through the USDG/USD feed, and blocks pricing while the stock issuer flags a corporate action (for example a split). |
| **FeeRouter** | Collects the protocol share and forwards all of it to BuyBurn. Anyone can trigger it. |
| **BuyBurn** | Swaps fees into $FILL and burns it, within per-run size limits and a minimum interval. |
| **FairToken** | The $FILL token. |
| **BorrowDesk** | One isolated lending market per Vault: lenders, borrowers, interest, liquidations. |
| **BasketProgram** | A multi-Vault strategy that spreads one deposit across several Vaults. Ships **closed** until governance opens it. |
| **VaultRegistry** | On-chain directory of every Vault, Credit Line and Program. |
| **TimelockController** | Holds admin power behind a 48-hour delay. |

### Key flows

**Deposit:** harvest pending fees, check that the pool price is within 2% of Chainlink, mint shares at the current value.

**Rebalance (keeper):** close the range, swap to the right mix (must clear within 1% of the oracle price), then open the new range. It reverts if the price is stale, the pool has drifted, or the Vault is paused.

**USDG exit:** pull the user's slice of the position and sell stock tokens for USDG within the 1% loss limit. **The exiting user pays their own swap cost**, so the holders who stay are unaffected. This is enforced and tested.

**In-kind exit:** return the user's share of stock tokens and USDG directly, with no swap and no price needed. This always works.

---

## 5. Safety design

### Prices can't be manipulated through the pool
Every valuation (share price, collateral value, even the value of the liquidity position itself) uses the **Chainlink price**, not the pool's live price. Someone who pushes the pool with a flash loan changes nothing that Stockfill measures.

### Market hours are handled explicitly
Chainlink stock feeds pause outside US market hours. When a price is stale (older than 26 hours), deposits, USDG exits, rebalances, borrowing and liquidations **stop automatically**. **In-kind exits and loan repayments never stop**, so users are never locked in.

### Roles are split, and nobody can take funds

| Role | Who | Can | Cannot |
|---|---|---|---|
| **Admin** | 48-hour timelock, controlled by a multisig | Unpause, raise caps, change parameters within hard limits | Act instantly; move user funds |
| **Guardian** | A separate multisig (enforced ≠ admin) | Pause, lower caps, halt drawdowns | Unpause, raise anything, move funds, block exits |
| **Keeper** | Operations wallet | Rebalance and run drawdowns within on-chain limits | Use unregistered pools or exceed loss limits |

No contract has a function that lets any role withdraw user deposits.

### Contained risk
- **Per-Vault caps:** each launch Vault opens with a $25,000 Held Value cap.
- **Isolated lending:** trouble in one Credit Line can't spread to another.
- **Concentration cap:** a single Credit Line can hold at most 30% of a Vault's shares as collateral.
- **Conservative borrowing:** 40% maximum LTV and liquidation at 55%. A maximum-size loan survives a roughly 27% fall in price before it can be liquidated.
- **Inflation-attack protection:** ERC-4626 decimal offset, plus seeding each Vault at launch.

---

## 6. How Stockfill compares to TickerSpring

Stockfill is based on Stonkwell (MIT), which was designed after a review of TickerSpring, an existing product on the same chain with a similar concept. TickerSpring's MIT-licensed contracts were read as a design reference only.

| Area | TickerSpring (observed on-chain) | Stockfill |
|---|---|---|
| Vault standard | Custom join/redeem (not ERC-4626) | Standard ERC-4626 |
| Uniswap version | v3 | v4 |
| Protocol fee use | 10% operations + 20% "buyback", sent to a wallet that has never held the token | 100% of the 30% share to an on-chain buy-and-burn with no withdrawal path |
| Changing fee recipients | Instant, by a single wallet | 48-hour public delay |
| Admin | One externally owned wallet | Timelock plus multisig, with a separate guardian |
| Oracle contract | Unverified | Verified, with checks documented and tested |
| Lending contracts | Unverified | Verified, isolated per Vault |
| Exits during outages | Not documented | In-kind exit always available |

---

## 7. Technology

- **Chain:** Robinhood Chain mainnet (chainId 4663)
- **Contracts:** Solidity 0.8.26, OpenZeppelin 5.1, Uniswap v4 (MIT-licensed parts only), Chainlink price feeds
- **Tooling:** Hardhat, with tests on mocks and on a live mainnet fork
- **Frontend:** Next.js 14, wagmi and viem. Pages: Home, Vaults, each Vault's page, Borrow Desk, Programs and Docs
- **Stablecoin:** USDG

### Launch configuration

| Item | Setting |
|---|---|
| Launch Vaults | TSLA, NVDA, AAPL, PLTR, META |
| Held Value cap per Vault | $25,000 |
| First Credit Line | META |
| Basket Program | Deployed closed |
| Timelock delay | 48 hours |
| Excluded for now | CRCL (empty pool), MSTR (broken pool) |

The remaining Equity Tokens (AMD, AMZN, MSFT, GOOGL and others) are listed in the app as later Vaults. Each opens once its pool has enough depth and tracks its Chainlink price closely.

---

## 8. Current status

| Area | Status |
|---|---|
| Smart contracts | ✅ Written |
| Unit tests | ✅ 33 passing |
| Mainnet-fork tests on the live Uniswap v4 META/USDG pool | ✅ 5 passing: deposit, rebalance, trading fees, 70/30 harvest, USDG and in-kind exits |
| Deploy script | ✅ Dry-run against a mainnet fork with real addresses |
| Web app | ✅ Builds; running locally against a seeded demo chain |
| Docs | ✅ Architecture, risk review, README, this overview |
| Independent audit | ⏳ Not started |
| Mainnet deployment | ⏳ Not deployed |

---

## 9. Road to launch

1. **Audit.** Get an independent security audit of Vault, VaultPositionV4, V4SwapAdapter, VaultOracle and BorrowDesk.
2. **Governance setup.** Create the admin multisig and the guardian multisig (different signers), plus a keeper wallet.
3. **Deploy.** Run the deploy script on Robinhood Chain, then have the timelock accept ownership of the oracle, registry and swap adapter.
4. **Seed and open.** Seed each launch Vault and open it at a $25k cap.
5. **Activate the burn.** Create a $FILL/USDG pool and register it, so drawdowns can start retiring $FILL.
6. **Harden.** Add Chainlink's sequencer-uptime check once a feed is published for the chain.
7. **Legal.** Get counsel review before opening to the public.
8. **Grow.** Raise caps gradually, add Vaults and Credit Lines, then open Programs.

### Planned Programs
- **Loop Program:** deposit, borrow against the shares, deposit again, up to a safe target. It unwinds automatically when risk rises.
- **Steady Range Program:** a wider, calmer range with fewer rebalances.
- **Market-Hours Program:** moves to USDG before weekends and holidays, and redeploys when markets reopen.

---

## 10. Key risks, stated plainly

- **Equity Tokens are not shares.** They are tokenized debt securities issued by Robinhood Assets (Jersey) Limited. Holders are exposed to the issuer and get no shareholder rights.
- **Not principal-protected.** Vault shares can lose value through stock price moves (impermanent loss), swap costs, or contract failure.
- **Weekend gaps.** Prices can jump when markets reopen, which can trigger liquidations on Credit Lines.
- **Smart-contract risk.** Tests and audits reduce risk but don't remove it.
- **Dependencies.** Chainlink, Uniswap v4, USDG, the Equity Token contracts and the Robinhood Chain sequencer are all third parties.

Full details: [`RISK_REVIEW.md`](RISK_REVIEW.md).

---

*Stockfill is independent software and is not affiliated with Robinhood, Robinhood Assets (Jersey) Limited, Paxos, Uniswap Labs, Chainlink Labs, or any company whose stock an Equity Token tracks. Nothing here is investment advice.*
