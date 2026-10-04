// Deploys Stockfill.
//   Local demo (mocks, seeded):  npx hardhat run scripts/deploy.js
//   Robinhood Chain:             npx hardhat run scripts/deploy.js --network robinhood
// Live deploys read roles from env: ADMIN_MULTISIG, GUARDIAN_MULTISIG, KEEPER_ADDRESS, TREASURY_MULTISIG.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");

// DEPLOY_LIVE=1 runs the live path on a mainnet fork (FORK=1) as a dry run.
const LIVE = network.name === "robinhood" || process.env.DEPLOY_LIVE === "1";
const REAL_ROLES = network.name === "robinhood";
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));

async function deploy(name, args = []) {
  const c = await ethers.deployContract(name, args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(18)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const roles = REAL_ROLES
    ? {
        admin: required("ADMIN_MULTISIG"),
        guardian: required("GUARDIAN_MULTISIG"),
        keeper: required("KEEPER_ADDRESS"),
        treasury: required("TREASURY_MULTISIG"),
      }
    : process.env.LOCAL_SINGLE_WALLET === "1"
      ? { admin: deployer.address, guardian: deployer.address, keeper: rest[2].address, treasury: deployer.address }
      : { admin: rest[0].address, guardian: rest[1].address, keeper: rest[2].address, treasury: rest[0].address };
  // One-wallet setups are allowed: every contract's admin is the timelock, so a guardian equal to the timelock's
  // proposer never makes a contract's admin and guardian the same address.

  console.log(`Deploying Stockfill to ${network.name} from ${deployer.address}`);
  const out = { network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), roles, vaults: {}, creditLines: {} };

  const delay = LIVE ? config.launch.timelockDelaySeconds : 60;
  const timelock = await deploy("TimelockStockfill", [delay, [roles.admin], [roles.admin], ethers.ZeroAddress]);
  out.timelock = await timelock.getAddress();

  const env = LIVE ? liveEnv() : await localEnv(deployer);
  out.usdg = env.usdg;

  // A live deploy can go out before $FILL exists (launching on Pons after the protocol is live): BuyBurn
  // then starts without a token and the deployer sets it once with scripts/set-fill-token.js. The local demo
  // always mints its own $FILL.
  const pendingFill = LIVE && !process.env.FILL_TOKEN_ADDRESS;
  const fillToken = process.env.FILL_TOKEN_ADDRESS
    ? await existingFillToken(process.env.FILL_TOKEN_ADDRESS)
    : pendingFill
      ? null
      : await deploy("TokenStockfill", [roles.treasury, wad(config.launch.fillTokenSupply)]);
  out.fillToken = fillToken ? await fillToken.getAddress() : null;
  out.fillTokenSetter = pendingFill ? deployer.address : null;
  if (pendingFill) console.log(`  ${"TokenStockfill".padEnd(18)} not yet: set it after the Pons launch with scripts/set-fill-token.js`);

  const oracle = await deploy("OracleStockfill", [
    deployer.address,
    env.sequencerFeed,
    env.usdgFeed,
    config.chainlink.usdgMaxAge,
    config.tokens.usdg.decimals,
  ]);
  out.oracle = await oracle.getAddress();

  const swap = LIVE
    ? await deploy("SwapAdapterStockfill", [deployer.address, config.uniswap.poolManager, env.usdg])
    : env.swap;
  out.swapAdapter = await swap.getAddress();
  if (LIVE) {
    // Buy-and-burn route: fee token, USDG, native ETH, $FILL. The $FILL/ETH pool is a hooked Pons launchpad pool,
    // registered after $FILL graduates (scripts/register-fill-pool.js). The hook and the hookless ETH/USDG leg are
    // set now, while the deployer still owns the adapter.
    await (await swap.setHookAllowed(config.pons.hook, true)).wait();
    const eth = config.uniswap.ethUsdgPool;
    await (await swap.setPool({ currency0: ethers.ZeroAddress, currency1: env.usdg, fee: eth.fee, tickSpacing: eth.tickSpacing, hooks: ethers.ZeroAddress })).wait();
    console.log(`  Pons hook allowed, ETH/USDG ${eth.fee}/${eth.tickSpacing} pool registered`);
  }

  const drawdown = await deploy("BuyBurnStockfill", [
    fillToken ?? ethers.ZeroAddress,
    swap,
    deployer.address,
    roles.guardian,
    roles.keeper,
    config.launch.drawdownMinIntervalSeconds,
    pendingFill ? deployer.address : ethers.ZeroAddress,
  ]);
  out.buyBurn = await drawdown.getAddress();
  // Small per-run buys: a fresh Pons pool holds a few ETH, so large buys move its price a lot.
  await (await drawdown.setInputLimit(env.usdg, usdgUnits(config.launch.drawdownMaxUsdgPerRun))).wait();

  const feeRouter = await deploy("FeeRouterStockfill", [out.timelock, drawdown]);
  out.feeRouter = await feeRouter.getAddress();

  const registry = await deploy("RegistryStockfill", [deployer.address]);
  out.registry = await registry.getAddress();

  for (const ticker of config.launch.vaults) {
    const t = env.equity[ticker];
    await (await oracle.setFeed(t.address, t.feed, config.chainlink.equityMaxAge)).wait();
    await (await drawdown.setInputLimit(t.address, wad(config.launch.drawdownMaxEquityPerRun))).wait();

    let position;
    if (LIVE) {
      const key = poolKey(t.address, env.usdg, t.fee, t.tickSpacing);
      await (await swap.setPool(key)).wait();
      position = await deploy("PositionStockfill", [
        config.uniswap.poolManager,
        config.uniswap.positionManager,
        config.uniswap.permit2,
        oracle,
        key,
        t.address,
        env.usdg,
      ]);
    } else {
      position = await deploy("MockPosition", [t.address, env.usdg, usdgUnits(t.price)]);
    }

    const vault = await deploy("VaultStockfill", [
      {
        usdg: env.usdg,
        equityToken: t.address,
        position: await position.getAddress(),
        oracle: out.oracle,
        swapAdapter: out.swapAdapter,
        feeRouter: out.feeRouter,
        admin: out.timelock,
        guardian: roles.guardian,
        keeper: roles.keeper,
        heldValueCap: usdgUnits(config.launch.heldValueCapUsdg),
      },
      `Stockfill ${ticker} Vault`,
      `sf${ticker}`,
    ]);
    await (await position.bind(vault)).wait();
    await (await registry.list(vault, 0, ticker)).wait();
    out.vaults[ticker] = { vault: await vault.getAddress(), position: await position.getAddress(), equityToken: t.address, name: t.name };
  }

  const cl = config.launch.creditLine;
  for (const ticker of config.launch.creditLines) {
    const desk = await deploy("BorrowDeskStockfill", [
      out.vaults[ticker].vault,
      out.feeRouter,
      out.timelock,
      roles.guardian,
      cl.risk,
      {
        baseRatePerYear: wad(cl.rates.baseRatePerYear),
        slope1PerYear: wad(cl.rates.slope1PerYear),
        slope2PerYear: wad(cl.rates.slope2PerYear),
        kinkUtilization: wad(cl.rates.kinkUtilization),
      },
      usdgUnits(cl.supplyCapUsdg),
      usdgUnits(cl.borrowCapUsdg),
      `Stockfill ${ticker} Credit Line`,
      `cl${ticker}`,
    ]);
    await (await registry.list(desk, 1, ticker)).wait();
    out.creditLines[ticker] = await desk.getAddress();
  }

  // BasketProgram refuses admin == guardian at construction. While the deployer is its temporary admin, a guardian
  // that is also the deployer (one-wallet setup) is parked on the timelock and moved over right after.
  const sameAsDeployer = roles.guardian.toLowerCase() === deployer.address.toLowerCase();
  const basket = await deploy("BasketStockfill", [
    env.usdg,
    deployer.address,
    sameAsDeployer ? out.timelock : roles.guardian,
    roles.keeper,
    "Stockfill Basket Program",
    "sfBASKET",
  ]);
  for (const ticker of config.launch.vaults) await (await basket.listVault(out.vaults[ticker].vault)).wait();
  if (sameAsDeployer) {
    const GUARDIAN = await basket.GUARDIAN_ROLE();
    await (await basket.grantRole(GUARDIAN, roles.guardian)).wait();
    await (await basket.revokeRole(GUARDIAN, out.timelock)).wait();
  }
  await (await registry.list(basket, 2, "BASKET")).wait();
  out.basketProgram = await basket.getAddress();

  if (!LIVE) await seedLocal(out, env, basket, rest);

  console.log("Handing governance to the timelock");
  const ADMIN = ethers.ZeroHash;
  for (const c of [drawdown, basket]) {
    await (await c.grantRole(ADMIN, out.timelock)).wait();
    await (await c.renounceRole(ADMIN, deployer.address)).wait();
  }
  for (const c of [oracle, registry, ...(LIVE ? [swap] : [])]) {
    await (await c.transferOwnership(out.timelock)).wait();
  }
  out.pendingTimelockAcceptances = [out.oracle, out.registry, ...(LIVE ? [out.swapAdapter] : [])];

  const label = REAL_ROLES ? network.name : LIVE ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
  console.log("Next: schedule acceptOwnership() through the timelock for:", out.pendingTimelockAcceptances.join(", "));
}

// BuyBurn stores the token immutably and calls burn(uint256) on it, so reject anything that can't burn.
async function existingFillToken(address) {
  if (!ethers.isAddress(address)) throw new Error("FILL_TOKEN_ADDRESS is not a valid address");
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at FILL_TOKEN_ADDRESS ${address}`);
  const token = await ethers.getContractAt("TokenStockfill", address);
  const [symbol, decimals, supply] = await Promise.all([token.symbol(), token.decimals(), token.totalSupply()]);
  if (decimals !== 18n) throw new Error(`$FILL must have 18 decimals, got ${decimals}`);
  try {
    await token.burn.staticCall(0);
  } catch {
    throw new Error(`Token at ${address} does not support burn(uint256), which BuyBurn requires`);
  }
  console.log(`  ${"TokenStockfill".padEnd(18)} ${address} (existing ${symbol}, supply ${ethers.formatEther(supply)})`);
  return token;
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address for live deploys`);
  return v;
}

function poolKey(equity, usdg, fee, tickSpacing) {
  const [currency0, currency1] = BigInt(equity) < BigInt(usdg) ? [equity, usdg] : [usdg, equity];
  return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
}

function liveEnv() {
  const pools = require("../config/robinhood.pools.json");
  const equity = {};
  for (const [ticker, t] of Object.entries(config.equityTokens)) {
    const p = pools[ticker] && pools[ticker].pool;
    equity[ticker] = {
      address: t.address,
      feed: t.chainlinkFeed,
      name: t.name,
      fee: p ? p.fee : config.uniswap.defaultFee,
      tickSpacing: p ? p.tickSpacing : config.uniswap.defaultTickSpacing,
    };
  }
  return {
    usdg: config.tokens.usdg.address,
    usdgFeed: config.chainlink.usdgUsdFeed,
    sequencerFeed: config.chainlink.sequencerUptimeFeed || ethers.ZeroAddress,
    equity,
  };
}

const DEMO_PRICES = { TSLA: 378.34, NVDA: 224.41, AAPL: 336.31, PLTR: 191.53, META: 778.25 };

async function localEnv(deployer) {
  console.log("Local demo: deploying mock USDG, Equity Tokens, feeds and swap venue");
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const usdgFeed = await deploy("MockAggregator", [8, 100_000_000]);
  const swap = await deploy("MockSwapAdapter");
  await (await usdg.mint(swap, usdgUnits(100_000_000))).wait();
  const equity = {};
  for (const ticker of config.launch.vaults) {
    const price = DEMO_PRICES[ticker];
    const token = await deploy("MockStockToken", [`${config.equityTokens[ticker].name} Equity Token`, ticker]);
    const feed = await deploy("MockAggregator", [8, Math.round(price * 1e8)]);
    await (await token.mint(swap, wad(1_000_000))).wait();
    await (await swap.setRate(token, usdg, (usdgUnits(price) * 10n ** 18n) / 10n ** 18n)).wait();
    await (await swap.setRate(usdg, token, (10n ** 36n) / usdgUnits(price))).wait();
    equity[ticker] = { address: await token.getAddress(), feed: await feed.getAddress(), name: config.equityTokens[ticker].name, price, token };
  }
  return { usdg: await usdg.getAddress(), usdgToken: usdg, usdgFeed: await usdgFeed.getAddress(), sequencerFeed: ethers.ZeroAddress, swap, equity };
}

async function seedLocal(out, env, basket, [, , keeper, demoUser]) {
  console.log("Seeding demo balances and positions");
  const usdg = env.usdgToken;
  await (await usdg.mint(demoUser.address, usdgUnits(250_000))).wait();
  await (await basket.setHeldValueCap(usdgUnits(100_000))).wait();
  for (const [ticker, w] of Object.entries(out.vaults)) {
    const vault = await ethers.getContractAt("VaultStockfill", w.vault);
    await (await usdg.connect(demoUser).approve(vault, usdgUnits(5_000))).wait();
    await (await vault.connect(demoUser).deposit(usdgUnits(5_000), demoUser.address)).wait();
    await (await vault.connect(keeper).rebalance(-600, 600, true, usdgUnits(2_500), "0x")).wait();
    const position = await ethers.getContractAt("MockPosition", w.position);
    const price = env.equity[ticker].price;
    await (await position.accrueFees(wad((25 / price).toFixed(6)), usdgUnits(25))).wait();
    await (await vault.harvest()).wait();
  }
  for (const [, desk] of Object.entries(out.creditLines)) {
    const d = await ethers.getContractAt("BorrowDeskStockfill", desk);
    await (await usdg.connect(demoUser).approve(d, usdgUnits(8_000))).wait();
    await (await d.connect(demoUser).deposit(usdgUnits(8_000), demoUser.address)).wait();
  }
  out.demoUser = demoUser.address;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
