const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const FEED = (n) => ethers.parseUnits(String(n), 8);
const WAD = 10n ** 18n;

/** Rate for MockSwapAdapter: out = in * rate / 1e18. */
function rate(outPerInUnit, inDecimals, outDecimals) {
  return (ethers.parseUnits(String(outPerInUnit), outDecimals) * WAD) / 10n ** BigInt(inDecimals);
}

async function deployVault(ctx, ticker, price) {
  const { admin, guardian, keeper, usdg, oracle, swap, feeRouter } = ctx;
  const equity = await ethers.deployContract("MockStockToken", [`${ticker} Equity Token`, ticker]);
  const feed = await ethers.deployContract("MockAggregator", [8, FEED(price)]);
  await oracle.connect(admin).setFeed(equity, feed, 3600);

  const position = await ethers.deployContract("MockPosition", [equity, usdg, USDG(price)]);
  const vault = await ethers.deployContract("VaultStockfill", [
    {
      usdg: await usdg.getAddress(),
      equityToken: await equity.getAddress(),
      position: await position.getAddress(),
      oracle: await oracle.getAddress(),
      swapAdapter: await swap.getAddress(),
      feeRouter: await feeRouter.getAddress(),
      admin: admin.address,
      guardian: guardian.address,
      keeper: keeper.address,
      heldValueCap: USDG(1_000_000),
    },
    `Stockfill ${ticker} Vault`,
    `w${ticker}`,
  ]);
  await position.bind(vault);

  await swap.setRate(equity, usdg, rate(price, 18, 6));
  await swap.setRate(usdg, equity, rate(1 / price, 6, 18));
  await equity.mint(swap, EQ(1_000_000));
  return { equity, feed, position, vault };
}

async function baseFixture() {
  const [admin, guardian, keeper, alice, bob, carol] = await ethers.getSigners();

  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const sequencer = await ethers.deployContract("MockAggregator", [0, 0]);
  const now = await time.latest();
  await sequencer.set(0, now - 7200, now);
  const usdgFeed = await ethers.deployContract("MockAggregator", [8, FEED(1)]);
  const oracle = await ethers.deployContract("OracleStockfill", [admin.address, sequencer, usdgFeed, 90_000, 6]);

  const swap = await ethers.deployContract("MockSwapAdapter");
  const fillToken = await ethers.deployContract("TokenStockfill", [admin.address, EQ(1_000_000_000)]);
  const drawdown = await ethers.deployContract("BuyBurnStockfill", [
    fillToken,
    swap,
    admin.address,
    guardian.address,
    keeper.address,
    3600,
    ethers.ZeroAddress,
  ]);
  const feeRouter = await ethers.deployContract("FeeRouterStockfill", [admin.address, drawdown]);

  await usdg.mint(swap, USDG(100_000_000));
  await fillToken.connect(admin).transfer(swap, EQ(100_000_000));
  await swap.setRate(usdg, fillToken, rate(100, 6, 18));

  for (const user of [alice, bob, carol]) await usdg.mint(user, USDG(1_000_000));

  const ctx = { admin, guardian, keeper, alice, bob, carol, usdg, usdgFeed, sequencer, oracle, swap, fillToken, drawdown, feeRouter };
  const amd = await deployVault(ctx, "AMD", 150);
  return { ...ctx, amd };
}

async function deposit(ctx, vault, user, amount) {
  await ctx.usdg.connect(user).approve(vault, amount);
  await vault.connect(user).deposit(amount, user.address);
}

module.exports = { USDG, EQ, FEED, WAD, rate, deployVault, baseFixture, deposit };
