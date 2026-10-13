# Stockfill

Best execution for Robinhood Stock Tokens on Robinhood Chain, plus Vaults that earn trading fees and a Borrow Desk.
Every contract carries the Stockfill name.

- **RouterStockfill** splits a swap across the Uniswap v3 and v4 pools that pay most, in one transaction. Sell an
  exact amount (minimum output) or buy an exact amount (maximum input, the rest refunded in the same transaction).
  Input comes from an allowance, an EIP-2612 permit or a Permit2 signature. No owner, no fee, no pause, no upgrades.
- **QuoterStockfill** prices every path in both directions by running the real swaps and reverting.
- **Vaults** (VaultStockfill and PositionStockfill, one pair per stock): deposit USDG and earn one stock's trading fees.
  A keeper holds the Vault's USDG as one concentrated Uniswap v4 range around Chainlink's price. Shares are valued at
  Chainlink; deposits and USDG exits wait while the pool is more than 2% off Chainlink; redeeming in kind always works.
  70% of fees compound for holders, 30% buys back and burns $FILL.
- **Basket** (BasketStockfill): one USDG deposit spread across every Vault. The keeper keeps about 20% in USDG for
  withdrawals; the contract refuses any allocation that would put more than 40% of the Basket into one Vault.
- **Credit Lines** (BorrowDeskStockfill): pledge Vault shares and borrow USDG up to 40% of their value, or lend USDG.
- **Governance:** once `./govern.sh handoff` has completed, every setting goes through TimelockStockfill (48 hours).
  The guardian can pause and lower caps, never raise them; withdrawals and repayments stay open while paused.

| Folder | Contents |
|---|---|
| `contracts/` | Foundry: RouterStockfill, QuoterStockfill and their tests |
| `vaults/` | Hardhat: the vault protocol (the `*Stockfill` contracts) and its deploy, verify and governance scripts |
| `engine/` | Routing engine: pool discovery, path search, split planning, permits |
| `keeper/` | The vault keeper |
| `web/` | Next.js app (static export): swap, markets, Vaults, Borrow, Portfolio |
| `tools/` | Wallet tools: encrypted keystores, keeper key straight into a GitHub secret |

Tests for the router and quoter, the vault protocol and the keeper (each line starts from the repository root):

```bash
cd contracts && forge test --no-match-contract Fork
cd vaults && npm test
cd keeper && npm test
```

MIT licensed (see `vaults/LICENSE`). Not independently audited. Nothing here is investment advice.
