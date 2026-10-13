// Deploys the Stockfill vault protocol. See scripts/stockfill.js for what goes out.
//   Robinhood Chain (launch.sh):   npx hardhat run scripts/deploy.js --network robinhood
//   Local demo (seeded):           npx hardhat run scripts/deploy.js --network localhost
// Live roles come from the environment launch.sh sets: ADMIN_MULTISIG (the dev wallet: the timelock's proposer and
// executor), GUARDIAN_MULTISIG and TREASURY_MULTISIG (also the dev wallet) and KEEPER_ADDRESS. Started again after a
// dropped connection, it continues where it stopped.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployStockfill, DEMO_PRICES } = require("./stockfill");

const LIVE = network.name === "robinhood";
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));
const send = async (p) => (await p).wait();

async function main() {
  const dir = path.join(__dirname, "..", "deployments");
  const file = path.join(dir, `${network.name}.json`);
  const progressFile = path.join(dir, `${network.name}.progress.json`);
  if (fs.existsSync(file) && !fs.existsSync(progressFile) && process.env.FORCE !== "1") {
    console.log(`Already deployed: ${path.relative(process.cwd(), file)}. Nothing to do.`);
    return;
  }
  const signers = await ethers.getSigners();
  const signer = signers[0];
  if (!signer) throw new Error("No dev wallet signer: keystore ~/.foundry/keystores/$DEPLOYER_ACCOUNT not found.");
  const roles = LIVE
    ? { admin: required("ADMIN_MULTISIG"), guardian: required("GUARDIAN_MULTISIG"), keeper: required("KEEPER_ADDRESS"), treasury: required("TREASURY_MULTISIG") }
    : { admin: signer.address, guardian: signer.address, keeper: signers[3].address, treasury: signer.address };

  const fillToken = LIVE ? process.env.FILL_TOKEN_ADDRESS || null : null;
  const { d, env } = await deployStockfill({ signer, roles, live: LIVE, progressFile, fillToken });
  if (!LIVE) await localToken(signer, d, env);
  if (!LIVE) await seedLocal(d, signers);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  fs.rmSync(progressFile, { force: true });
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
  console.log(`Next: the timelock accepts ownership of ${d.pendingTimelockAcceptances.length} contracts (./govern.sh handoff).`);
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address for a live deploy`);
  return v;
}

/** Local demo $FILL at 0.01 USDG on the mock venue, plugged into BuyBurn the way set-token.sh does live. */
async function localToken(signer, d, env) {
  const t = await (await ethers.getContractFactory("TokenStockfill", signer)).deploy(signer.address, wad(1_000_000_000));
  await t.waitForDeployment();
  const swap = await ethers.getContractAt("MockSwapAdapter", env.swap, signer);
  await send(t.transfer(swap, wad(100_000_000)));
  await send(swap.setRate(env.usdg, t, 10n ** 32n));
  for (const [ticker, m] of Object.entries(env.equity)) await send(swap.setRate(m.address, t, wad(Math.round(DEMO_PRICES[ticker] * 100))));
  const bb = await ethers.getContractAt("BuyBurnStockfill", d.buyBurn, signer);
  await send(bb.setFillToken(t));
  d.fillToken = await t.getAddress();
  d.fillTokenSetter = null;
}

/** Gives the local demo something to show: Vault deposits in range, fees, funded credit lines with a loan, a Basket. */
async function seedLocal(d, signers) {
  const [, , , keeper, demo, borrower] = signers;
  console.log("Seeding the local demo");
  const usdg = await ethers.getContractAt("MockERC20", d.usdg);
  for (const who of [demo, borrower]) await send(usdg.mint(who.address, usdgUnits(500_000)));
  const amounts = { NVDA: 14_900, TSLA: 12_400, AAPL: 8_800, META: 11_200, GOOGL: 6_300, MSFT: 9_600, SPY: 10_100 };
  for (const [t, w] of Object.entries(d.vaults)) {
    const vault = await ethers.getContractAt("VaultStockfill", w.vault);
    const amount = amounts[t] ?? 5_000;
    await send(usdg.connect(demo).approve(vault, usdgUnits(amount)));
    await send(vault.connect(demo).deposit(usdgUnits(amount), demo.address));
    // A range about 12% either side of the demo price, in the ticks of a stock/USDG pool with the stock as token0.
    const mid = Math.floor(Math.log((DEMO_PRICES[t] * 1e6) / 1e18) / Math.log(1.0001));
    const lower = Math.floor((mid - 1200) / 60) * 60;
    const upper = Math.ceil((mid + 1200) / 60) * 60;
    await send(vault.connect(keeper).rebalance(lower, upper, true, usdgUnits(amount / 2), "0x"));
    const position = await ethers.getContractAt("MockPosition", w.position);
    const fee = amount * 0.0021;
    await send(position.accrueFees(wad((fee / DEMO_PRICES[t]).toFixed(6)), usdgUnits(fee.toFixed(2))));
    await send(vault.harvest());
  }
  for (const [t, desk] of Object.entries(d.creditLines)) {
    const c = await ethers.getContractAt("BorrowDeskStockfill", desk);
    await send(usdg.connect(demo).approve(c, usdgUnits(6_000)));
    await send(c.connect(demo).deposit(usdgUnits(6_000), demo.address));
    const vault = await ethers.getContractAt("VaultStockfill", await c.vault());
    await send(usdg.connect(borrower).approve(vault, usdgUnits(3_000)));
    await send(vault.connect(borrower).deposit(usdgUnits(3_000), borrower.address));
    const shares = ((await vault.totalSupply()) * 25n) / 100n;
    const mine = await vault.balanceOf(borrower.address);
    const pledge = shares < mine ? shares : mine;
    await send(vault.connect(borrower).approve(c, pledge));
    await send(c.connect(borrower).pledge(pledge));
    await send(c.connect(borrower).borrow(usdgUnits(t === "META" ? 900 : 600), borrower.address));
  }
  const basket = await ethers.getContractAt("BasketStockfill", d.basketProgram);
  await send(usdg.connect(demo).approve(basket, usdgUnits(12_000)));
  await send(basket.connect(demo).deposit(usdgUnits(12_000), demo.address));
  const vaults = await basket.vaults();
  const each = usdgUnits(Math.floor(9_000 / vaults.length));
  for (const v of vaults) await send(basket.connect(keeper).allocate(v, each));
  d.demoUser = demo.address;
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
