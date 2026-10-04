// Mainnet-fork test of the full Vault lifecycle on the live Uniswap v4 META / USDG pool.
// Run with: FORK=1 npx hardhat test
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const config = require("../../config/robinhood.json");

const USDG_WHALE = "0x4B431ec432CC11ebd4E460D8eC12057F07b2FFf6";
const TICKER = "META";
const usdgAmt = (n) => ethers.parseUnits(String(n), 6);

describe(`Vault on a Robinhood Chain fork (${TICKER}/USDG)`, function () {
  let admin, guardian, keeper, alice, trader;
  let usdg, equity, oracle, swap, position, vault, feeRouter, key;

  before(async function () {
    [admin, guardian, keeper, alice, trader] = await ethers.getSigners();
    const t = config.equityTokens[TICKER];
    usdg = await ethers.getContractAt("IERC20", config.tokens.usdg.address);
    equity = await ethers.getContractAt("IERC20", t.address);

    await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDG_WHALE] });
    await network.provider.send("hardhat_setBalance", [USDG_WHALE, "0x56BC75E2D63100000"]);
    const whale = await ethers.getSigner(USDG_WHALE);
    await usdg.connect(whale).transfer(alice, usdgAmt(20_000));
    await usdg.connect(whale).transfer(trader, usdgAmt(200_000));

    oracle = await ethers.deployContract("OracleStockfill", [
      admin.address,
      ethers.ZeroAddress,
      config.chainlink.usdgUsdFeed,
      config.chainlink.usdgMaxAge,
      6,
    ]);
    // Equity feeds stop updating while the market is closed. FORK_EQUITY_MAX_AGE (seconds) lets the suite run on weekends.
    await oracle.setFeed(t.address, t.chainlinkFeed, process.env.FORK_EQUITY_MAX_AGE || config.chainlink.equityMaxAge);

    const [c0, c1] = BigInt(t.address) < BigInt(config.tokens.usdg.address)
      ? [t.address, config.tokens.usdg.address]
      : [config.tokens.usdg.address, t.address];
    key = { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };

    swap = await ethers.deployContract("SwapAdapterStockfill", [admin.address, config.uniswap.poolManager, config.tokens.usdg.address]);
    await swap.setPool(key);

    const fillToken = await ethers.deployContract("TokenStockfill", [admin.address, ethers.parseEther("1000000000")]);
    const drawdown = await ethers.deployContract("BuyBurnStockfill", [fillToken, swap, admin.address, guardian.address, keeper.address, 3600, ethers.ZeroAddress]);
    feeRouter = await ethers.deployContract("FeeRouterStockfill", [admin.address, drawdown]);

    position = await ethers.deployContract("PositionStockfill", [
      config.uniswap.poolManager,
      config.uniswap.positionManager,
      config.uniswap.permit2,
      oracle,
      key,
      t.address,
      config.tokens.usdg.address,
    ]);
    vault = await ethers.deployContract("VaultStockfill", [
      {
        usdg: config.tokens.usdg.address,
        equityToken: t.address,
        position: await position.getAddress(),
        oracle: await oracle.getAddress(),
        swapAdapter: await swap.getAddress(),
        feeRouter: await feeRouter.getAddress(),
        admin: admin.address,
        guardian: guardian.address,
        keeper: keeper.address,
        heldValueCap: usdgAmt(1_000_000),
      },
      `Stockfill ${TICKER} Vault`,
      `w${TICKER}`,
    ]);
    await position.bind(vault);
  });

  it("prices META from Chainlink and sees a live pool", async function () {
    expect(await vault.priceFresh()).to.equal(true);
    const unit = ethers.parseEther("1");
    const fair = await oracle.usdgValue(equity, unit);
    const spot = await position.spotUsdgValue(unit);
    console.log(`      oracle ${ethers.formatUnits(fair, 6)} USDG, pool ${ethers.formatUnits(spot, 6)} USDG`);
    expect(fair).to.be.gt(0);
  });

  it("deposits USDG and opens a concentrated range around the current tick", async function () {
    await usdg.connect(alice).approve(vault, usdgAmt(10_000));
    await vault.connect(alice).deposit(usdgAmt(10_000), alice.address);
    expect(await vault.totalAssets()).to.equal(usdgAmt(10_000));

    const [, tick] = await position.slot0();
    const lower = (Math.floor(Number(tick) / 60) - 20) * 60;
    const upper = (Math.floor(Number(tick) / 60) + 20) * 60;
    await vault.connect(keeper).rebalance(lower, upper, true, usdgAmt(5_000), "0x");

    expect(await position.liquidity()).to.be.gt(0);
    const held = await vault.totalAssets();
    console.log(`      Held Value after rebalance ${ethers.formatUnits(held, 6)} USDG`);
    expect(held).to.be.closeTo(usdgAmt(10_000), usdgAmt(150));
  });

  it("earns swap fees from traders and sends 30% to the FeeRouter on harvest", async function () {
    await usdg.connect(trader).approve(swap, ethers.MaxUint256);
    await equity.connect(trader).approve(swap, ethers.MaxUint256);
    for (let i = 0; i < 3; i++) {
      await swap.connect(trader).swap(usdg, equity, usdgAmt(20_000), 0, trader.address, "0x");
      const bal = await equity.balanceOf(trader);
      await swap.connect(trader).swap(equity, usdg, bal, 0, trader.address, "0x");
    }

    await vault.harvest();
    const grossU = await vault.grossUsdgFees();
    const grossE = await vault.grossEquityFees();
    console.log(`      gross fees: ${ethers.formatUnits(grossU, 6)} USDG + ${ethers.formatEther(grossE)} META`);
    expect(grossU + grossE).to.be.gt(0);
    expect(await usdg.balanceOf(feeRouter)).to.equal((grossU * 3000n) / 10000n);
  });

  it("redeems in kind and exits to USDG through the live pool", async function () {
    const shares = await vault.balanceOf(alice);
    const e0 = await equity.balanceOf(alice);
    const u0 = await usdg.balanceOf(alice);
    await vault.connect(alice).redeemInKind(shares / 2n, alice.address, alice.address, 0, 0);
    expect(await equity.balanceOf(alice)).to.be.gt(e0);
    expect(await usdg.balanceOf(alice)).to.be.gt(u0);

    const max = await vault.maxWithdraw(alice);
    const u1 = await usdg.balanceOf(alice);
    await vault.connect(alice).withdraw(max / 2n, alice.address, alice.address);
    expect((await usdg.balanceOf(alice)) - u1).to.equal(max / 2n);
  });

  it("moves the range again and ends holding nothing in the position contract", async function () {
    const [, tick] = await position.slot0();
    const lower = (Math.floor(Number(tick) / 60) - 10) * 60;
    const upper = (Math.floor(Number(tick) / 60) + 10) * 60;
    await vault.connect(keeper).rebalance(lower, upper, false, 0, "0x");
    expect(await position.tickLower()).to.equal(lower);
    expect(await usdg.balanceOf(position)).to.equal(0);
    expect(await equity.balanceOf(position)).to.equal(0);
  });
});
