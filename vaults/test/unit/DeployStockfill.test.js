// scripts/stockfill.js on real Uniswap v4 bytecode: the live deploy path end to end, a stop halfway and a rerun, the
// roles every contract ends up with, the timelock handoff, and the deployed Vaults, credit line and Basket in use.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const V4 = require("../uniswap/v4.json");
const { deployStockfill } = require("../../scripts/stockfill");
const { handoff } = require("../../scripts/timelock-accept");
const { planRebalance } = require("../../../keeper/src/plan");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const DAY2 = 172_800;
const PLAN = { halfWidthTicks: 1200, edgeThresholdPct: 15, minSwapUsdg: "5", minIdleUsdg: "10", maxIdlePct: 25 };

function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

async function world() {
  const [dev, keeper, lp, user, other] = await ethers.getSigners();
  await network.provider.send("hardhat_setCode", [V4.Permit2.address, V4.Permit2.runtime]);
  const make = (name, ...args) => new ethers.ContractFactory(V4[name].abi, V4[name].bytecode, lp).deploy(...args);
  const pm = await make("PoolManager", lp.address);
  const posm = await make("PositionManager", pm, V4.Permit2.address, 300_000, lp.address, lp.address);
  const lpRouter = await make("PoolModifyLiquidityTest", pm);
  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  for (const who of [lp, user]) await usdg.mint(who, USDG(1_000_000_000));
  await usdg.connect(lp).approve(lpRouter, ethers.MaxUint256);
  const equity = {};
  for (const [t, price] of [["META", 740], ["NVDA", 180]]) {
    const stock = await ethers.deployContract("MockStockToken", [t, t]);
    await stock.mint(lp, EQ(1_000_000));
    await stock.connect(lp).approve(lpRouter, ethers.MaxUint256);
    const s0 = BigInt(await stock.getAddress()) < BigInt(await usdg.getAddress());
    const key = { currency0: s0 ? await stock.getAddress() : await usdg.getAddress(), currency1: s0 ? await usdg.getAddress() : await stock.getAddress(), fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };
    const raw = BigInt(price * 1e6);
    await pm.initialize(key, s0 ? isqrt((raw << 192n) / 10n ** 18n) : isqrt((10n ** 18n << 192n) / raw));
    await lpRouter.connect(lp).modifyLiquidity(key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 2n * 10n ** 18n, salt: ethers.ZeroHash }, "0x");
    const feed = await ethers.deployContract("MockAggregator", [8, BigInt(price) * 10n ** 8n]);
    equity[t] = { address: await stock.getAddress(), feed: await feed.getAddress(), name: t, fee: 3000, tickSpacing: 60 };
  }
  const usdgFeed = await ethers.deployContract("MockAggregator", [8, 100_000_000]);
  const chain = {
    usdg: await usdg.getAddress(),
    equity,
    usdgFeed: await usdgFeed.getAddress(),
    sequencerFeed: ethers.ZeroAddress,
    uniswap: { poolManager: await pm.getAddress(), positionManager: await posm.getAddress(), permit2: V4.Permit2.address },
    vaults: ["META", "NVDA"],
    lines: ["META"],
  };
  return { dev, keeper, user, other, usdg, chain, roles: { admin: dev.address, guardian: dev.address, keeper: keeper.address, treasury: dev.address } };
}

async function fresh() {
  const w = await loadFixture(world);
  return { ...w, progressFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfill-")), "progress.json") };
}
const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};
const run = (w, extra = {}) => quiet(() => deployStockfill({ signer: w.dev, roles: w.roles, live: true, progressFile: w.progressFile, chain: w.chain, ...extra }));

describe("Stockfill deploy (scripts/stockfill.js) on real Uniswap v4", function () {
  it("deploys everything with the timelock in charge and the dev wallet only as guardian", async function () {
    const w = await fresh();
    const { d } = await run(w);
    const tl = d.timelock;
    expect(Object.keys(d.vaults)).to.deep.equal(["META", "NVDA"]);
    expect(Object.keys(d.creditLines)).to.deep.equal(["META"]);
    expect(d.pendingTimelockAcceptances).to.deep.equal([d.swapAdapter, d.oracle, d.registry]);
    for (const [t, v] of Object.entries(d.vaults)) {
      const vault = await ethers.getContractAt("VaultStockfill", v.vault);
      expect(await vault.hasRole(ethers.ZeroHash, tl), `${t} admin`).to.equal(true);
      expect(await vault.hasRole(ethers.ZeroHash, w.dev.address)).to.equal(false);
      expect(await vault.hasRole(await vault.GUARDIAN_ROLE(), w.dev.address)).to.equal(true);
      expect(await vault.hasRole(await vault.KEEPER_ROLE(), w.keeper.address)).to.equal(true);
      expect(await vault.symbol()).to.equal(`sf${t}`);
    }
    const bb = await ethers.getContractAt("BuyBurnStockfill", d.buyBurn);
    expect(await bb.hasRole(ethers.ZeroHash, tl)).to.equal(true);
    expect(await bb.hasRole(ethers.ZeroHash, w.dev.address)).to.equal(false);
    expect(await bb.maxInputPerRun(w.chain.equity.NVDA.address)).to.equal(EQ("0.5"));
    expect(await bb.fillTokenSetter()).to.equal(w.dev.address);
    const basket = await ethers.getContractAt("BasketStockfill", d.basketProgram);
    expect(await basket.vaults()).to.deep.equal([d.vaults.META.vault, d.vaults.NVDA.vault]);
    expect(await basket.hasRole(ethers.ZeroHash, tl)).to.equal(true);
    expect(await basket.hasRole(ethers.ZeroHash, w.dev.address)).to.equal(false);
    expect(await basket.hasRole(await basket.GUARDIAN_ROLE(), w.dev.address)).to.equal(true);
    expect(await basket.hasRole(await basket.GUARDIAN_ROLE(), tl)).to.equal(false);
    // Closed until the handoff batch opens it, like every Vault.
    expect(await basket.heldValueCap()).to.equal(0n);
    expect(await (await ethers.getContractAt("VaultStockfill", d.vaults.META.vault)).heldValueCap()).to.equal(0n);
    expect(d.openCaps.map((c) => c.target)).to.deep.equal([d.vaults.META.vault, d.vaults.NVDA.vault, d.basketProgram]);
    const fr = await ethers.getContractAt("FeeRouterStockfill", d.feeRouter);
    expect(await fr.owner()).to.equal(tl);
    expect(await fr.buyBurn()).to.equal(d.buyBurn);
    const reg = await ethers.getContractAt("RegistryStockfill", d.registry);
    expect((await reg.entries()).map((e) => [e.ticker, Number(e.kind)])).to.deep.equal([["META", 0], ["NVDA", 0], ["META", 1], ["BASKET", 2]]);
  });

  it("continues after a stop halfway and sends nothing twice", async function () {
    const w = await fresh();
    let n = 0;
    const flaky = new Proxy(w.dev, {
      get(target, prop) {
        if (prop === "sendTransaction") return async (tx) => { if (++n > 14) throw new Error("connection dropped"); return target.sendTransaction(tx); };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(run(w, { signer: flaky })).to.be.rejectedWith("connection dropped");
    const half = JSON.parse(fs.readFileSync(w.progressFile, "utf8"));
    const again = await run(w);
    expect(again.d.timelock).to.equal(half.timelock);
    expect(Object.keys(again.d.vaults)).to.deep.equal(["META", "NVDA"]);
    expect((await run(w)).sent).to.equal(0);
  });

  it("refuses any wallet but the dev wallet", async function () {
    const w = await fresh();
    await expect(run(w, { signer: w.other })).to.be.rejectedWith("Deploy from the dev wallet");
  });

  it("hands the swap adapter, oracle and registry to the timelock", async function () {
    const w = await fresh();
    const { d } = await run(w);
    let op = await handoff(ethers.provider, d);
    expect(op.status).to.equal("unscheduled");
    await w.dev.sendTransaction(op.schedule);
    await time.increase(DAY2);
    op = await handoff(ethers.provider, d);
    await w.dev.sendTransaction(op.execute);
    for (const a of [d.swapAdapter, d.oracle, d.registry]) expect(await (await ethers.getContractAt("OracleStockfill", a)).owner()).to.equal(d.timelock);
    // The same batch opened deposits.
    expect(await (await ethers.getContractAt("VaultStockfill", d.vaults.META.vault)).heldValueCap()).to.equal(USDG(25_000));
    expect(await (await ethers.getContractAt("BasketStockfill", d.basketProgram)).heldValueCap()).to.equal(USDG(50_000));
    expect((await handoff(ethers.provider, d)).status).to.equal("done");
  });

  it("works once deployed and handed off: a Vault placed by the keeper, the Basket and the credit line", async function () {
    const w = await fresh();
    const { d } = await run(w);
    const meta0 = await ethers.getContractAt("VaultStockfill", d.vaults.META.vault);
    expect(await meta0.maxDeposit(w.user.address)).to.equal(0n);
    let op = await handoff(ethers.provider, d);
    await w.dev.sendTransaction(op.schedule);
    await time.increase(DAY2);
    op = await handoff(ethers.provider, d);
    await w.dev.sendTransaction(op.execute);
    // Two days passed: the mock feeds need a fresh round, as Chainlink would have posted.
    for (const t of ["META", "NVDA"]) {
      const f = await ethers.getContractAt("MockAggregator", w.chain.equity[t].feed);
      await f.setAnswer(await f.answer());
    }
    const uf = await ethers.getContractAt("MockAggregator", w.chain.usdgFeed);
    await uf.setAnswer(await uf.answer());
    const meta = await ethers.getContractAt("VaultStockfill", d.vaults.META.vault);
    const pos = await ethers.getContractAt("PositionStockfill", d.vaults.META.position);
    const oracle = await ethers.getContractAt("OracleStockfill", d.oracle);
    await w.usdg.connect(w.user).approve(meta, USDG(5_000));
    await meta.connect(w.user).deposit(USDG(5_000), w.user.address);
    const [slot, , , , fair, [heldE, heldU]] = await Promise.all([pos.slot0(), pos.liquidity(), pos.tickLower(), pos.tickUpper(), oracle.usdgValue(w.chain.equity.META.address, EQ(1)), meta.holdings()]);
    const plan = planRebalance({ cfg: PLAN, fair, equityUnit: EQ(1), equityIsToken0: await pos.equityIsToken0(), spacing: 60, sqrtPriceX96: slot[0], poolTick: Number(slot[1]), liquidity: 0n, lower: 0, upper: 0, heldE, heldU, idleE: heldE, idleU: heldU });
    await meta.connect(w.keeper).rebalance(plan.target.lower, plan.target.upper, plan.sellUsdg, plan.amount, "0x");
    expect(await pos.liquidity()).to.be.gt(0n);
    expect(await meta.totalAssets()).to.be.gt(USDG(4_950));

    const basket = await ethers.getContractAt("BasketStockfill", d.basketProgram);
    await w.usdg.connect(w.user).approve(basket, USDG(4_000));
    await basket.connect(w.user).deposit(USDG(4_000), w.user.address);
    await basket.connect(w.keeper).allocate(d.vaults.NVDA.vault, USDG(1_500));
    expect(await basket.totalAssets()).to.be.closeTo(USDG(4_000), USDG(2));

    const desk = await ethers.getContractAt("BorrowDeskStockfill", d.creditLines.META);
    await w.usdg.connect(w.user).approve(desk, ethers.MaxUint256);
    await desk.connect(w.user).deposit(USDG(2_000), w.user.address);
    const pledge = ((await meta.totalSupply()) * 25n) / 100n;
    await meta.connect(w.user).approve(desk, pledge);
    await desk.connect(w.user).pledge(pledge);
    await desk.connect(w.user).borrow(USDG(400), w.user.address);
    await desk.connect(w.user).repay(ethers.MaxUint256, w.user.address);
    expect(await desk.debtOf(w.user.address)).to.equal(0n);
  });
});
