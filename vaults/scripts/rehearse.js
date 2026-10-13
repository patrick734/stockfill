// Rehearses the whole Stockfill vault deploy on a local copy of Robinhood Chain (FORK=1), against the real Uniswap v4 pools
// and Chainlink feeds, as the dev wallet. Then it uses what it deployed: USDG into every Vault, the keeper places each
// range, an exact USDG withdrawal, a redemption in kind, the Basket put to work, and a credit-line loan repaid in full.
// Ends with what the real deploy will cost against the dev wallet's balance. Nothing is sent to Robinhood Chain.
//   FORK=1 ADMIN_MULTISIG=0x.. GUARDIAN_MULTISIG=0x.. KEEPER_ADDRESS=0x.. npx hardhat run scripts/rehearse.js
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");
const { deployStockfill } = require("./stockfill");
const { planRebalance } = require("../../keeper/src/plan");
const keeperCfg = require("../../keeper/config.json");

const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const fmt = (v) => ethers.formatUnits(v, 6);
const send = async (p) => (await p).wait();
let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};

async function as(address) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH, on the local copy only
  return ethers.getSigner(address);
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address`);
  return ethers.getAddress(v);
}

async function main() {
  if (network.name !== "hardhat" || !process.env.FORK) throw new Error("Run with FORK=1 on the hardhat network.");
  const roles = { admin: required("ADMIN_MULTISIG"), guardian: required("GUARDIAN_MULTISIG"), keeper: required("KEEPER_ADDRESS"), treasury: required("TREASURY_MULTISIG") };
  // Mine one local block first: Hardhat cannot run calls against the forked block itself on a chain it has no
  // hardfork history for, but it can on every block it mines on top.
  await network.provider.send("evm_mine", []);
  const dev = roles.admin;
  const devBalance = await ethers.provider.getBalance(dev);
  const realChain = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl, config.network.chainId, { staticNetwork: true });
  const gasPrice = (await realChain.getFeeData()).gasPrice ?? 0n;
  const startBlock = await ethers.provider.getBlockNumber();
  const signer = await as(dev);

  const progressFile = path.join(__dirname, "..", "deployments", "fork.progress.json");
  fs.rmSync(progressFile, { force: true });
  let d;
  try {
    ({ d } = await deployStockfill({ signer, roles, live: true, progressFile, fillToken: null }));
  } finally {
    fs.rmSync(progressFile, { force: true });
  }

  let gas = 0n;
  const endBlock = await ethers.provider.getBlockNumber();
  for (let b = startBlock + 1; b <= endBlock; b++) {
    const block = await ethers.provider.getBlock(b, true);
    for (const t of block.prefetchedTransactions) {
      if (t.from.toLowerCase() === dev.toLowerCase()) gas += (await ethers.provider.getTransactionReceipt(t.hash)).gasUsed;
    }
  }

  console.log("\nUsing it");
  // Deposits open in the 48h handoff batch on the real chain. Here the timelock opens the caps directly, as that batch will.
  const tlSigner = await as(d.timelock);
  for (const c of d.openCaps) await send((await ethers.getContractAt("VaultStockfill", c.target, tlSigner)).setHeldValueCap(BigInt(c.cap)));
  const usdg = await ethers.getContractAt("MockERC20", d.usdg);
  const user = (await ethers.getSigners())[5];
  // The PoolManager holds the USDG of every v4 pool: borrow some for the rehearsal user.
  const pm = await as(config.uniswap.poolManager);
  const held = await usdg.balanceOf(pm.address);
  await send(usdg.connect(pm).transfer(user.address, held < usdgUnits(20_000) ? held : usdgUnits(20_000)));
  const keeper = await as(roles.keeper);
  const oracle = await ethers.getContractAt("OracleStockfill", d.oracle);
  const lineTickers = Object.keys(d.creditLines);
  let exercised = 0;

  for (const [t, w] of Object.entries(d.vaults)) {
    const vault = await ethers.getContractAt("VaultStockfill", w.vault);
    const position = await ethers.getContractAt("PositionStockfill", w.position);
    if (!(await vault.priceFresh())) {
      console.log(`  skip  ${t}: Chainlink price not fresh right now (market closed)`);
      continue;
    }
    try {
      await send(usdg.connect(user).approve(vault, usdgUnits(1_000)));
      await send(vault.connect(user).deposit(usdgUnits(1_000), user.address));
      const stock = await ethers.getContractAt("MockERC20", w.equityToken);
      const unit = 10n ** BigInt(await stock.decimals());
      const [slot, liquidity, lower, upper, fair, [heldS, heldU], idleS, idleU, key, s0] = await Promise.all([
        position.slot0(), position.liquidity(), position.tickLower(), position.tickUpper(), oracle.usdgValue(w.equityToken, unit),
        vault.holdings(), stock.balanceOf(vault), usdg.balanceOf(vault), position.poolKey(), position.equityIsToken0(),
      ]);
      const plan = planRebalance({
        cfg: keeperCfg.rebalance, fair, equityUnit: unit, equityIsToken0: s0, spacing: Number(key.tickSpacing), sqrtPriceX96: slot[0],
        poolTick: Number(slot[1]), liquidity, lower: Number(lower), upper: Number(upper), heldE: heldS, heldU, idleE: idleS, idleU,
      });
      let placed = false;
      for (const size of [plan.amount, plan.amount / 2n, plan.amount / 4n]) {
        try {
          await send(vault.connect(keeper).rebalance(plan.target.lower, plan.target.upper, plan.sellUsdg, size, "0x"));
          placed = (await position.liquidity()) > 0n;
          if (placed) break;
        } catch {}
      }
      exercised++;
      check(placed, `${t}: 1,000 USDG in, keeper placed the range [${plan.target.lower}, ${plan.target.upper}]`);
      const value = await vault.totalAssets();
      check(value > usdgUnits(970), `${t}: Vault worth ${fmt(value)} USDG after placing it`);
      const before = await usdg.balanceOf(user.address);
      await send(vault.connect(user).withdraw(usdgUnits(300), user.address, user.address));
      check((await usdg.balanceOf(user.address)) - before === usdgUnits(300), `${t}: exact 300 USDG withdrawal`);
      if (!lineTickers.includes(t)) {
        await send(vault.connect(user).redeemInKind(await vault.balanceOf(user.address), user.address, user.address, 0, 0));
        check((await vault.balanceOf(user.address)) === 0n, `${t}: the rest redeemed in kind`);
      }
    } catch (e) {
      check(false, `${t}: ${e.shortMessage || e.message}`);
    }
  }

  for (const [t, address] of Object.entries(d.creditLines)) {
    const desk = await ethers.getContractAt("BorrowDeskStockfill", address);
    const vault = await ethers.getContractAt("VaultStockfill", await desk.vault());
    if (!(await vault.priceFresh()) || (await vault.balanceOf(user.address)) === 0n) {
      console.log(`  skip  ${t} credit line: needs a fresh price and Vault shares`);
      continue;
    }
    try {
      await send(usdg.connect(user).approve(desk, ethers.MaxUint256));
      await send(desk.connect(user).deposit(usdgUnits(500), user.address));
      // A credit line takes at most maxCollateralShareBps (30%) of a Vault shares as collateral.
      const shares = ((await vault.totalSupply()) * 25n) / 100n;
      await send(vault.connect(user).approve(desk, shares));
      await send(desk.connect(user).pledge(shares));
      const room = await desk.borrowable(user.address);
      await send(desk.connect(user).borrow(room / 2n, user.address));
      check((await desk.debtOf(user.address)) > 0n, `${t} credit line: borrowed ${fmt(room / 2n)} USDG against Vault shares`);
      await send(desk.connect(user).repay(ethers.MaxUint256, user.address));
      await send(desk.connect(user).release(shares, user.address));
      check((await desk.debtOf(user.address)) === 0n, `${t} credit line: repaid and shares released`);
    } catch (e) {
      check(false, `${t} credit line: ${e.shortMessage || e.message}`);
    }
  }

  const basket = await ethers.getContractAt("BasketStockfill", d.basketProgram);
  if (await basket.pricesUsable()) {
    try {
      await send(usdg.connect(user).approve(basket, usdgUnits(2_000)));
      await send(basket.connect(user).deposit(usdgUnits(2_000), user.address));
      const pools = await basket.vaults();
      const each = usdgUnits(Math.floor(1_500 / pools.length));
      for (const p of pools) await send(basket.connect(keeper).allocate(p, each));
      const total = await basket.totalAssets();
      check(total > usdgUnits(1_990), `Basket: 2,000 USDG in, spread over ${pools.length} Vaults, worth ${fmt(total)}`);
      const before = await usdg.balanceOf(user.address);
      await send(basket.connect(user).withdraw(usdgUnits(300), user.address, user.address));
      check((await usdg.balanceOf(user.address)) - before === usdgUnits(300), "Basket: 300 USDG withdrawal from its idle USDG");
      await send(basket.connect(user).redeemInKind(await basket.balanceOf(user.address), user.address, user.address));
      check((await basket.totalSupply()) === 0n, "Basket: the rest redeemed in kind as Vault shares");
    } catch (e) {
      check(false, `Basket: ${e.shortMessage || e.message}`);
    }
  }

  if (!exercised) {
    console.log("  FAIL  No Vault could be tried: Chainlink prices are not fresh right now. Run the rehearsal again on a weekday.");
    failures++;
  }
  // Execution gas only: Robinhood Chain also charges for posting the data to Ethereum, hence the wide margin.
  const cost = gas * gasPrice;
  console.log(`\nThe real deploy uses about ${gas} gas: about ${ethers.formatEther(cost)} ETH of execution at today's gas price, plus a data fee.`);
  console.log(`The dev wallet ${dev} holds ${ethers.formatEther(devBalance)} ETH.`);
  if (gasPrice === 0n) {
    console.log("  FAIL  Could not read today's gas price from Robinhood Chain. Run the rehearsal again.");
    failures++;
  } else if (devBalance < cost * 3n) {
    console.log("  FAIL  Not enough ETH for the deploy with a safety margin. Withdraw more from KuCoin or OKX to the dev wallet.");
    failures++;
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
