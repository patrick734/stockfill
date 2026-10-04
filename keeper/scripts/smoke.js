// End-to-end smoke test of the keeper against a local Hardhat node running the mock demo deploy.
//
// First terminal, from the repository root:
//   cd vaults && npx hardhat node --port 8547
// Second terminal: deploy the demo (writes vaults/deployments/keeper.json), then run this script:
//   cd vaults && npx hardhat run scripts/deploy.js --network keeper
//   cd ../keeper && npm run smoke
//
// Env: RPC_URL (default http://127.0.0.1:8547), KEEPER_NETWORK (default keeper).
// Refuses to run on anything but a Hardhat chain (31337): it mints mocks and moves time.
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8547";
const NETWORK = process.env.KEEPER_NETWORK || "keeper";
// Hardhat's well-known dev account #3, which deploy.js makes the keeper on local chains. Not a secret.
const HARDHAT_KEEPER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

process.env.KEEPER_NETWORK = NETWORK;
const { loadDeployment } = require("../src/config");
const abis = require("../src/abis");

const MOCK_POSITION = [
  "function accrueFees(uint256 equityFees, uint256 usdgFees)",
  "function pendingEquityFees() view returns (uint256)",
  "function pendingUsdgFees() view returns (uint256)",
];
const MOCK_SWAP = ["function setRate(address tokenIn, address tokenOut, uint256 rateWad)"];
const MOCK_FEED = ["function setAnswer(int256)", "function answer() view returns (int256)"];
const ERC20_RW = [...abis.ERC20, "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}

function runKeeper(label, extraEnv) {
  console.log(`\n===== keeper --once (${label}) =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js"), "--once"], {
    env: {
      ...process.env,
      RPC_URL,
      KEEPER_NETWORK: NETWORK,
      KEEPER_CONFIG: path.join(__dirname, "smoke.config.json"),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  if (r.status !== 0) {
    console.log(`  FAIL keeper exited with ${r.status}`);
    failures++;
  }
  return out;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error(`smoke test only runs on a Hardhat node (chainId 31337), got ${chainId}`);
  const dep = loadDeployment(NETWORK);
  const accounts = await provider.send("eth_accounts", []);
  const treasury = await provider.getSigner(dep.roles.treasury);
  const demoUser = await provider.getSigner(dep.demoUser || accounts[4]);
  const anyone = await provider.getSigner(accounts[0]);
  const keeperKey = process.env.KEEPER_PRIVATE_KEY || HARDHAT_KEEPER_KEY;
  if (new ethers.Wallet(keeperKey).address.toLowerCase() !== dep.roles.keeper.toLowerCase()) {
    throw new Error("KEEPER_PRIVATE_KEY does not match roles.keeper in the deployment");
  }

  const bal = (token, who) => new ethers.Contract(token, abis.ERC20, provider).balanceOf(who);
  const tokens = [dep.usdg, ...Object.values(dep.vaults).map((w) => w.equityToken)];
  const dd = new ethers.Contract(dep.buyBurn, abis.BuyBurn, provider);
  const fillToken = new ethers.Contract(dep.fillToken, ERC20_RW, treasury);

  console.log("Setting up local test conditions");
  // 1. Fresh trading fees on every mock position.
  for (const [ticker, w] of Object.entries(dep.vaults)) {
    const pos = new ethers.Contract(w.position, MOCK_POSITION, anyone);
    await (await pos.accrueFees(ethers.parseEther("0.1"), ethers.parseUnits("40", 6))).wait();
    console.log(`  accrued fees on ${ticker}`);
  }
  // 2. Let the mock swap venue sell $FILL: fund it from the treasury and set rates.
  await (await fillToken.transfer(dep.swapAdapter, ethers.parseEther("10000000"))).wait();
  const swap = new ethers.Contract(dep.swapAdapter, MOCK_SWAP, anyone);
  await (await swap.setRate(dep.usdg, dep.fillToken, 10n ** 32n)).wait(); // 1 USDG -> 100 FILL
  for (const w of Object.values(dep.vaults)) await (await swap.setRate(w.equityToken, dep.fillToken, ethers.parseEther("10000"))).wait();
  // 3. A borrower on the Credit Line, so interest builds reserves.
  const [ticker, deskAddr] = Object.entries(dep.creditLines)[0];
  const desk = new ethers.Contract(deskAddr, abis.BorrowDesk, demoUser);
  const vault = new ethers.Contract(dep.vaults[ticker].vault, [...abis.Vault], demoUser);
  const shares = (await vault.balanceOf(dep.demoUser)) / 5n;
  await (await vault.approve(deskAddr, shares)).wait();
  await (await desk.pledge(shares)).wait();
  await (await desk.borrow(ethers.parseUnits("300", 6), dep.demoUser)).wait();
  await provider.send("evm_increaseTime", [30 * 86400]);
  await provider.send("evm_mine", []);
  console.log(`  demo user borrowed 300 USDG on the ${ticker} Credit Line; advanced 30 days`);
  // Mock feeds keep their original updatedAt, so refresh every price after the time jump.
  const oracle = new ethers.Contract(dep.oracle, abis.VaultOracle, provider);
  for (const w of Object.values(dep.vaults)) {
    const [agg] = await oracle.feeds(w.equityToken);
    const f = new ethers.Contract(agg, MOCK_FEED, anyone);
    await (await f.setAnswer(await f.answer())).wait();
  }
  const usdgFeed = new ethers.Contract(await oracle.usdgFeed(), MOCK_FEED, anyone);
  await (await usdgFeed.setAnswer(await usdgFeed.answer())).wait();

  // ---------------------------------------------------------------- dry run: nothing may change
  const snapshot = async () => ({
    router: await Promise.all(tokens.map((t) => bal(t, dep.feeRouter))),
    retired: await dd.totalRetired(),
    reserves: await desk.reserves(),
    pendingUsdg: await Promise.all(Object.values(dep.vaults).map((w) => new ethers.Contract(w.position, MOCK_POSITION, provider).pendingUsdgFees())),
  });
  const before = await snapshot();
  const dryOut = runKeeper("DRY_RUN=1", { DRY_RUN: "1", KEEPER_PRIVATE_KEY: keeperKey });
  const afterDry = await snapshot();
  console.log("\nDry-run checks");
  check(JSON.stringify(before, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(afterDry, (_, v) => (typeof v === "bigint" ? v.toString() : v)), "dry run changed no state");
  check(/harvest: DRY_RUN, would send/.test(dryOut), "dry run would harvest");
  check(/claimReserves: DRY_RUN, would send/.test(dryOut), "dry run would claim reserves");
  check(/routeMany: DRY_RUN, would send/.test(dryOut), "dry run would route fees");
  check(!dryOut.includes(keeperKey.slice(2)), "private key never printed");

  // ---------------------------------------------------------------- live run
  const liveOut = runKeeper("DRY_RUN=0", { DRY_RUN: "0", KEEPER_PRIVATE_KEY: keeperKey });
  const after = await snapshot();
  console.log("\nLive-run checks");
  check(after.pendingUsdg.every((x) => x === 0n), "every Vault harvested (no pending fees left)");
  check(after.reserves === 0n, "BorrowDesk reserves claimed");
  check(after.router.every((x) => x === 0n), "FeeRouter emptied into BuyBurn");
  check(after.retired > before.retired, `drawdown retired $FILL (${ethers.formatEther(after.retired - before.retired)})`);
  check((liveOut.match(/drawdown: confirmed/g) || []).length === 1, "exactly one drawdown (shared minInterval)");
  check(!liveOut.includes(keeperKey.slice(2)), "private key never printed");

  // ---------------------------------------------------------------- rate limit, then next interval
  const again = runKeeper("DRY_RUN=0, same interval", { DRY_RUN: "0", KEEPER_PRIVATE_KEY: keeperKey });
  check(/rate limited by minInterval/.test(again), "second run inside minInterval is skipped");
  check(!/harvest: sent/.test(again) && /no pending fees/.test(again), "no harvest sent when nothing is pending");
  check(!/WARN|ERROR/.test(again), "routine re-run logs no warnings or errors");
  const interval = Number(await dd.minInterval());
  await provider.send("evm_increaseTime", [interval + 1]);
  await provider.send("evm_mine", []);
  const retiredBefore = await dd.totalRetired();
  runKeeper("DRY_RUN=0, next interval", { DRY_RUN: "0", KEEPER_PRIVATE_KEY: keeperKey });
  check((await dd.totalRetired()) > retiredBefore, "next interval draws down the next fee token");

  // ---------------------------------------------------------------- unhealthy account reporting
  const [agg] = await oracle.feeds(dep.vaults[ticker].equityToken);
  const feed = new ethers.Contract(agg, MOCK_FEED, anyone);
  const price = await feed.answer();
  await (await feed.setAnswer(price / 20n)).wait();
  const unhealthy = runKeeper("price crash, health scan", { DRY_RUN: "1", KEEPER_PRIVATE_KEY: keeperKey });
  check(/UNHEALTHY account/.test(unhealthy), "unhealthy borrower is reported");
  await (await feed.setAnswer(price)).wait();

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll smoke checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
