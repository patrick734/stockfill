# Stockfill

Best execution for Robinhood Stock Tokens on Robinhood Chain, plus Vaults that earn trading fees and a Borrow Desk.
Every contract carries the Stockfill name.

- **RouterStockfill** splits a swap across the Uniswap v3 and v4 pools that pay most, in one transaction. Sell an
  exact amount (minimum output) or buy an exact amount (maximum input, the rest refunded in the same transaction).
  Input comes from an allowance, an EIP-2612 permit or a Permit2 signature. No owner, no fee, no pause, no upgrades.
- **QuoterStockfill** prices every path in both directions by running the real swaps and reverting.
- **Vaults** (VaultStockfill and its companion contracts, based on the MIT-licensed Stonkwell): deposit USDG and earn
  one stock's trading fees. 70% compounds for holders, 30% buys back and burns $FILL. Settings changes wait 48 hours
  in TimelockStockfill.

| Folder | Contents |
|---|---|
| `contracts/` | Foundry: RouterStockfill, QuoterStockfill and their tests |
| `vaults/` | Hardhat: the vault protocol (the `*Stockfill` contracts) and its deploy, verify and governance scripts |
| `engine/` | Routing engine: pool discovery, path search, split planning, permits |
| `keeper/` | The vault keeper |
| `web/` | Next.js app (static export): swap, markets, Vaults, Borrow, Portfolio |
| `tools/` | Wallet tools: encrypted keystores, keeper key straight into a GitHub secret |

Tests for the router and quoter, the vault protocol and the keeper, each run from the repository root:

```bash
cd contracts && forge test --no-match-contract Fork
cd vaults && npm test
cd keeper && npm test
```

Not independently audited. Nothing here is investment advice.
