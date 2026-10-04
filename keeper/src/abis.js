// ABIs come from the Hardhat build output in vaults/artifacts (run `npx hardhat compile` in vaults/ first).
// This keeps the keeper in lockstep with the Solidity source and covers SwapAdapterStockfill, which
// web/src/generated/vaults/abis.ts does not export. KEEPER_ARTIFACTS_DIR overrides the location (the
// directory that contains `src/`).
const fs = require("fs");
const path = require("path");
const { CONTRACTS } = require("./config");

const DIR = process.env.KEEPER_ARTIFACTS_DIR || path.join(CONTRACTS, "artifacts");

const FILES = {
  Vault: "src/VaultStockfill.sol/VaultStockfill.json",
  VaultOracle: "src/OracleStockfill.sol/OracleStockfill.json",
  FeeRouter: "src/FeeRouterStockfill.sol/FeeRouterStockfill.json",
  BuyBurn: "src/BuyBurnStockfill.sol/BuyBurnStockfill.json",
  BorrowDesk: "src/BorrowDeskStockfill.sol/BorrowDeskStockfill.json",
  VaultPositionV4: "src/v4/PositionStockfill.sol/PositionStockfill.json",
  V4SwapAdapter: "src/v4/SwapAdapterStockfill.sol/SwapAdapterStockfill.json",
};

// Standard ERC-20 surface; no need for an artifact.
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function load(name) {
  const file = path.join(DIR, FILES[name]);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ABI artifact ${file}. Run \`npx hardhat compile\` in vaults/ first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

const abis = Object.fromEntries(Object.keys(FILES).map((n) => [n, load(n)]));
abis.ERC20 = ERC20;

module.exports = abis;
