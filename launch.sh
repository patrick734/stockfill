#!/usr/bin/env bash
# Stockfill launch: deploys everything from one dev wallet and exports the addresses to the website.
#   1. The swap side (contracts/, Foundry): RouterStockfill and QuoterStockfill. No owner on either.
#   2. The vault protocol (vaults/, Hardhat): Vaults, oracle, swap adapter, fee router, BuyBurn, Borrow Desk,
#      Basket Program, registry and the 48h timelock. The dev wallet is the timelock's proposer and executor, the
#      guardian and the treasury. The keeper is a separate bot wallet, since it signs on its own.
#
#   ./launch.sh               real deploy to Robinhood Chain
#   ./launch.sh --rehearsal   the same on a local copy of the live chain; spends nothing
#
# The dev wallet signs from ~/.foundry/keystores/$DEPLOYER_ACCOUNT (default stockfill-dev, made by
# `node tools/wallet.js create stockfill-dev`), unlocked with ~/.foundry/stockfill.pw. No key is typed or printed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
VAULTS="$ROOT/vaults"; EXEC="$ROOT/contracts"; GEN="$ROOT/web/src/generated"
REHEARSAL=0; FORCE=0
for a in "$@"; do case "$a" in --rehearsal) REHEARSAL=1 ;; --force) FORCE=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done
step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
stop() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }
mtime() { [ -f "$1" ] && { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; } || echo none; }

step "Settings"
for d in "$VAULTS" "$ROOT/keeper"; do [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund) ; done
[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install --no-audit --no-fund)
. "$ROOT/tools/env.sh"
[ -f "$ROOT/launch.env" ] && { load_launch_env "$ROOT/launch.env"; echo "Loaded launch.env"; }
[[ "${KEEPER_ADDRESS:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || stop "KEEPER_ADDRESS is not set in launch.env (node tools/wallet.js keeper-secret <owner/repo> prints it)."
export RPC_URL="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
[ -z "${FILL_TOKEN_ADDRESS:-}" ] && echo "No FILL_TOKEN_ADDRESS: deploying before \$FILL. After the Pons launch, run ./set-token.sh <address>."

export DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-stockfill-dev}"
KS="$HOME/.foundry/keystores/$DEPLOYER_ACCOUNT"; PW="${DEPLOYER_PASSWORD_FILE:-$HOME/.foundry/stockfill.pw}"
[ -f "$KS" ] || stop "No dev wallet keystore $KS. Create it with: node tools/wallet.js create $DEPLOYER_ACCOUNT"
DEV="$(node "$ROOT/tools/wallet.js" address "$DEPLOYER_ACCOUNT")" || stop "Could not unlock the dev wallet keystore."
export DEPLOYER_ADDRESS="$DEV"
# One wallet holds every human role. Refuse role addresses left over from a multisig setup.
lc() { echo "$1" | tr A-F a-f; }
for n in ADMIN_MULTISIG GUARDIAN_MULTISIG TREASURY_MULTISIG; do
  v="${!n:-}"; [ -z "$v" ] || [ "$(lc "$v")" = "$(lc "$DEV")" ] || stop "$n in launch.env is $v, not the dev wallet. Remove it from launch.env (one-wallet launch)."
done
export ADMIN_MULTISIG="$DEV" GUARDIAN_MULTISIG="$DEV" TREASURY_MULTISIG="$DEV"
echo "Dev wallet: $DEV (deployer, timelock proposer/executor, guardian, treasury)"
echo "Keeper:     $KEEPER_ADDRESS"
[ "$(echo "$KEEPER_ADDRESS" | tr A-F a-f)" != "$(echo "$DEV" | tr A-F a-f)" ] || stop "The keeper must be a separate wallet from the dev wallet."

OUT="$VAULTS/deployments/robinhood.json"
if [ $REHEARSAL = 0 ] && [ -f "$OUT" ] && [ $FORCE = 0 ]; then stop "vaults/deployments/robinhood.json exists: already deployed. Use --force only for a second deployment."; fi

cd "$VAULTS" || exit 1
step "Refreshing live pool data"
node scripts/probe-pools.js | grep -E "TSLA|NVDA|AAPL|PLTR|META|chainId" || stop "Could not read the live pools. Check your connection (or set ROBINHOOD_RPC_URL) and run again."
step "Preflight checks"
node scripts/preflight.js || stop "Preflight failed. Fix the FAIL lines above and run again."

if [ $REHEARSAL = 1 ]; then
  step "Rehearsal: RouterStockfill and QuoterStockfill (simulated against the live chain, not sent)"
  (cd "$EXEC" && forge script script/DeployStockfill.s.sol --rpc-url robinhood --sender "$DEV" 2>&1 | grep -E "ROUTER=|QUOTER=|PERMIT2=|Error|error") || stop "Router simulation failed."
  step "Rehearsal: vault protocol on a local copy of Robinhood Chain"
  FORK=1 DEPLOY_LIVE=1 LOCAL_SINGLE_WALLET=1 npx hardhat run scripts/deploy.js 2>&1 | grep -v '^\s\+at '
  [ "${PIPESTATUS[0]}" = 0 ] || stop "Rehearsal deploy failed."
  rm -f "$VAULTS/deployments/fork.json"
  step "Rehearsal complete. Nothing was sent to Robinhood Chain."; exit 0
fi

printf '\n\033[33mThis deploys Stockfill to Robinhood Chain with real gas from %s.\033[0m\n' "$DEV"
read -r -p "Type DEPLOY to continue: " ans; [ "$ans" = "DEPLOY" ] || stop "Cancelled."

step "1/2 Swap contracts: RouterStockfill, QuoterStockfill"
if grep -q '"router"' "$GEN/router.json" 2>/dev/null && [ $FORCE = 0 ]; then
  echo "Already deployed: $(cat "$GEN/router.json")"
else
  RUN="$EXEC/broadcast/DeployStockfill.s.sol/4663/run-latest.json"
  rm -f "$RUN"   # never read a previous run's record
  (cd "$EXEC" && forge script script/DeployStockfill.s.sol --rpc-url robinhood --broadcast --slow \
      --account "$DEPLOYER_ACCOUNT" --password-file "$PW" 2>&1 | grep -v '^\s\+at '; exit "${PIPESTATUS[0]}")
  fstatus=$?
  [ -f "$RUN" ] || stop "The swap contracts were not sent (forge exit $fstatus). Nothing was deployed; fix the message above and run ./launch.sh again."
  node -e '
    const r = require(process.argv[1]); const fs = require("fs");
    const ok = (name) => {
      const tx = r.transactions.find((t) => t.contractName === name && t.contractAddress);
      const rc = tx && (r.receipts || []).find((x) => x.contractAddress && x.contractAddress.toLowerCase() === tx.contractAddress.toLowerCase());
      if (!tx || !rc || rc.status !== "0x1") { console.error(name + " deployment not confirmed"); process.exit(1); }
      return { address: tx.contractAddress, block: Number(rc.blockNumber) };
    };
    const router = ok("RouterStockfill"), quoter = ok("QuoterStockfill");
    const out = { router: router.address, quoter: quoter.address, block: router.block };
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
    console.log("RouterStockfill", out.router); console.log("QuoterStockfill", out.quoter, "block", out.block);
  ' "$RUN" "$GEN/router.json" || stop "The swap contracts did not both deploy. Nothing else was sent; run ./launch.sh again."
fi

step "2/2 Vault protocol"
ok=0
for attempt in 1 2 3; do
  before="$(mtime "$OUT")"
  npx hardhat run scripts/deploy.js --network robinhood 2>&1 | grep -v '^\s\+at '
  status=${PIPESTATUS[0]}
  [ "$status" = 0 ] && [ "$(mtime "$OUT")" != "none" ] && [ "$(mtime "$OUT")" != "$before" ] && { ok=1; break; }
  # A half-finished attempt holds no funds and the site never lists it; a retry deploys a full fresh set.
  printf '\033[33mAttempt %s did not finish (usually a dropped connection to the Robinhood RPC).\033[0m\n' "$attempt"
  [ $attempt -lt 3 ] && sleep 10
done
[ $ok = 1 ] || stop "Vault deploy did not finish after 3 attempts. The swap contracts are deployed (kept). Try another connection or set ROBINHOOD_RPC_URL in launch.env, then run ./launch.sh again."

step "Exporting addresses to the website"
npm run export-abis || stop "Deployed, but exporting addresses failed. Run: (cd vaults && npm run export-abis)"
step "Deployed"
echo "Addresses: web/src/generated/router.json and vaults/deployments/robinhood.json"
echo "Next:"
echo "  1. Publish (Vercel rebuilds; the keeper starts dry runs): git add -A && git commit -m Deploy && git push"
echo "  2. Publish the source code: ./verify.sh"
echo "  3. Timelock handoff (run it again after 48h): ./govern.sh handoff"
echo "  4. Keeper live: set the GitHub repo variable KEEPER_LIVE=1."
