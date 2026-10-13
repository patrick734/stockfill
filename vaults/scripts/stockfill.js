// Deploys the Stockfill vault protocol from one wallet. Shared by deploy.js (the real deploy and the local demo) and
// rehearse.js (a local copy of Robinhood Chain).
//
//   TimelockStockfill      48h: admin of every Vault, credit line and the Basket, owner of the fee router, and (after
//                          ./govern.sh handoff) of the swap adapter, oracle and registry
//   SwapAdapterStockfill   the Uniswap v4 pools the protocol may swap through
//   BuyBurnStockfill       spends protocol fees on $FILL and burns it; no withdraw function
//   OracleStockfill        Chainlink prices for the Stock Tokens, in USDG
//   FeeRouterStockfill     forwards the Vaults' and credit lines' protocol share to BuyBurn
//   RegistryStockfill      the on-chain list of Vaults, credit lines and the Basket
//   PositionStockfill      one per Vault: its range in the hookless Stock Token / USDG Uniswap v4 pool
//   VaultStockfill         one per Vault: USDG deposits kept in a range around the Chainlink price
//   BorrowDeskStockfill    one per credit line: lenders supply USDG, borrowers pledge Vault shares
//   BasketStockfill        one deposit spread across the Vaults
//
// Every step is checked on chain before it is sent and every new address is saved the moment it exists, so a run that
// stops halfway (a dropped RPC connection) continues where it stopped when started again.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const config = require("../config/robinhood.json");

const L = config.launch;
const ADMIN = ethers.ZeroHash;
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));
const send = async (p) => (await p).wait();
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const DEMO_PRICES = { NVDA: 237.19, TSLA: 376.33, AAPL: 336.41, META: 720.89, GOOGL: 350.69, MSFT: 531.57, SPY: 775.9 };

function poolKey(equity, usdg, fee, tickSpacing) {
  const [currency0, currency1] = BigInt(equity) < BigInt(usdg) ? [equity, usdg] : [usdg, equity];
  return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
}

/**
 * @param {object} o
 * @param {import("ethers").Signer} o.signer  the dev wallet (live), its impersonation (rehearsal) or a local account
 * @param {{admin: string, guardian: string, keeper: string, treasury: string}} o.roles
 * @param {boolean} o.live                     real Uniswap pools and Chainlink feeds (live and rehearsal)
 * @param {string} o.progressFile              where addresses are saved as they appear
 * @param {string|null} o.fillToken            $FILL if it already exists, else null (set later with set-token.sh)
 * @param {object} [o.chain]                   tests only: { usdg, equity, usdgFeed, sequencerFeed, uniswap, vaults, lines }
 * Live (and rehearsal) deploys start every Vault and the Basket with a cap of 0: deposits open in the same timelock
 * batch that hands the oracle, registry and swap adapter to the timelock, so nobody can deposit while the dev wallet
 * alone still controls the price feeds. The local demo opens them straight away.
 * @returns {Promise<{d: object, sent: number, env: object}>} the deployment record
 */
async function deployStockfill({ signer, roles, live, progressFile, fillToken = null, chain }) {
  const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : {};
  const remember = (k, v) => {
    progress[k] = v;
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2) + "\n");
  };
  if (progress.block === undefined) remember("block", await ethers.provider.getBlockNumber());
  let sent = 0;
  const tx = async (p) => {
    sent++;
    return send(p);
  };
  async function contract(keyName, name, args) {
    if (progress[keyName]) {
      // Never deploy a second copy of something already recorded: a missing contract here means a bad RPC answer.
      if ((await ethers.provider.getCode(progress[keyName])) === "0x")
        throw new Error(`${name} ${progress[keyName]} is recorded but the RPC shows no code there. Run again in a minute.`);
      console.log(`  ${name.padEnd(20)} ${progress[keyName]} (already deployed)`);
      return ethers.getContractAt(name, progress[keyName], signer);
    }
    const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
    await c.waitForDeployment();
    sent++;
    const a = await c.getAddress();
    remember(keyName, a);
    console.log(`  ${name.padEnd(20)} ${a}`);
    return c;
  }

  const me = await signer.getAddress();
  if (!same(me, roles.admin)) throw new Error(`Deploy from the dev wallet ${roles.admin}, not ${me}.`);
  if (same(roles.keeper, roles.admin)) throw new Error("The keeper must be a separate wallet from the dev wallet.");
  const env = chain || (live ? liveEnv(progress) : await localEnv(signer, progress, remember));
  const openCaps = []; // [{ target, cap }] for the handoff batch
  const uniswap = (chain && chain.uniswap) || config.uniswap;
  console.log(`Deploying the Stockfill vault protocol from ${me}`);

  // ---------------------------------------------------------------- governance and the burn side
  const timelock = await contract("timelock", "TimelockStockfill", [live ? L.timelockDelaySeconds : 60, [roles.admin], [roles.admin], ethers.ZeroAddress]);
  const tl = await timelock.getAddress();

  const swap = live
    ? await contract("swapAdapter", "SwapAdapterStockfill", [me, uniswap.poolManager, env.usdg])
    : await ethers.getContractAt("MockSwapAdapter", env.swap, signer);
  const ownsSwap = live && same(await swap.owner(), me);
  if (live && ownsSwap) {
    // Buy-and-burn route: fee token, USDG, native ETH, $FILL. The $FILL/ETH pool is a hooked Pons launchpad pool,
    // registered after $FILL graduates (./govern.sh register-pool); the hook and the ETH/USDG leg are set now.
    if (!(await swap.hookAllowed(config.pons.hook))) await tx(swap.setHookAllowed(config.pons.hook, true));
    const [, ethPool] = await swap.poolFor(ethers.ZeroAddress, env.usdg);
    const e = config.uniswap.ethUsdgPool;
    if (!ethPool) await tx(swap.setPool({ currency0: ethers.ZeroAddress, currency1: env.usdg, fee: e.fee, tickSpacing: e.tickSpacing, hooks: ethers.ZeroAddress }));
  }

  const pendingFill = !fillToken;
  const buyBurn = await contract("buyBurn", "BuyBurnStockfill", [
    fillToken ?? ethers.ZeroAddress,
    await swap.getAddress(),
    me,
    roles.guardian,
    roles.keeper,
    L.drawdownMinIntervalSeconds,
    pendingFill ? me : ethers.ZeroAddress,
  ]);
  const bbAdmin = await buyBurn.hasRole(ADMIN, me);
  const limit = async (input, amount) => {
    if ((await buyBurn.maxInputPerRun(input)) === amount) return;
    if (!bbAdmin) throw new Error("BuyBurn already belongs to the timelock; set input limits through it.");
    await tx(buyBurn.setInputLimit(input, amount));
  };
  // Small per-run buys: a fresh Pons pool holds a few ETH, so large buys move its price a lot.
  await limit(env.usdg, usdgUnits(L.drawdownMaxUsdgPerRun));

  const oracle = await contract("oracle", "OracleStockfill", [me, env.sequencerFeed, env.usdgFeed, config.chainlink.usdgMaxAge, config.tokens.usdg.decimals]);
  const feeRouter = await contract("feeRouter", "FeeRouterStockfill", [tl, await buyBurn.getAddress()]);
  const registry = await contract("registry", "RegistryStockfill", [me]);

  const d = {
    network: live ? "robinhood" : "local",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    roles,
    block: progress.block,
    timelock: tl,
    usdg: env.usdg,
    fillToken: fillToken,
    fillTokenSetter: pendingFill ? me : null,
    oracle: await oracle.getAddress(),
    swapAdapter: await swap.getAddress(),
    buyBurn: await buyBurn.getAddress(),
    feeRouter: await feeRouter.getAddress(),
    registry: await registry.getAddress(),
    vaults: {},
    creditLines: {},
  };

  // ---------------------------------------------------------------- Vaults
  console.log("Vaults");
  const tickers = (chain && chain.vaults) || L.vaults;
  const oracleOwned = same(await oracle.owner(), me);
  for (const t of tickers) {
    const m = env.equity[t];
    if (!m) continue;
    const [feed] = await oracle.feeds(m.address);
    if (!same(feed, m.feed)) {
      if (!oracleOwned) throw new Error("The oracle already belongs to the timelock; set feeds through it.");
      await tx(oracle.setFeed(m.address, m.feed, config.chainlink.equityMaxAge));
    }
    if (live) {
      // The Vault sells and buys its Stock Token through the swap adapter's registered pool.
      const [key, exists] = await swap.poolFor(m.address, env.usdg);
      if (!exists) {
        if (!ownsSwap) {
          console.log(`  ${t.padEnd(6)} skipped: no ${t}/USDG pool on the swap adapter, which the timelock now owns`);
          continue;
        }
        await tx(swap.setPool(poolKey(m.address, env.usdg, m.fee, m.tickSpacing)));
      } else if (Number(key.fee) !== Number(m.fee) || Number(key.tickSpacing) !== Number(m.tickSpacing)) {
        console.log(`  ${t.padEnd(6)} note: the range sits in the ${m.fee}/${m.tickSpacing} pool and swaps use the ${key.fee}/${key.tickSpacing} pool`);
      }
    }
    // Vault fees arrive in USDG and in the Stock Token: BuyBurn takes both.
    await limit(m.address, wad(L.drawdownMaxEquityPerRun));
    const position = live
      ? await contract(`position.${t}`, "PositionStockfill", [uniswap.poolManager, uniswap.positionManager, uniswap.permit2, d.oracle, poolKey(m.address, env.usdg, m.fee, m.tickSpacing), m.address, env.usdg])
      : await contract(`position.${t}`, "MockPosition", [m.address, env.usdg, usdgUnits(DEMO_PRICES[t])]);
    const vault = await contract(`vault.${t}`, "VaultStockfill", [
      {
        usdg: env.usdg,
        equityToken: m.address,
        position: await position.getAddress(),
        oracle: d.oracle,
        swapAdapter: d.swapAdapter,
        feeRouter: d.feeRouter,
        admin: tl,
        guardian: roles.guardian,
        keeper: roles.keeper,
        heldValueCap: live ? 0n : usdgUnits(L.heldValueCapUsdg),
      },
      `Stockfill ${t} Vault`,
      `sf${t}`,
    ]);
    if (!same(await vault.position(), await position.getAddress())) throw new Error(`The ${t} Vault is not tied to its recorded position.`);
    if (same(await position.vault(), ethers.ZeroAddress)) await tx(position.bind(vault));
    if (!same(await position.vault(), await vault.getAddress())) throw new Error(`The ${t} position is bound to another Vault.`);
    if ((await registry.indexPlusOne(vault)) === 0n) await tx(registry.list(vault, 0, t));
    d.vaults[t] = { vault: await vault.getAddress(), position: await position.getAddress(), equityToken: m.address, name: m.name };
    if (live) openCaps.push({ target: await vault.getAddress(), cap: usdgUnits(L.heldValueCapUsdg).toString() });
  }
  const vaultTickers = Object.keys(d.vaults);
  if (!vaultTickers.length) throw new Error("No Vault could be deployed.");
  console.log(`  ${vaultTickers.join(" ")}`);

  // ---------------------------------------------------------------- credit lines
  const cl = L.creditLine;
  for (const t of (chain && chain.lines) || L.creditLines) {
    if (!d.vaults[t]) {
      console.log(`  ${t} credit line skipped: no ${t} Vault`);
      continue;
    }
    const desk = await contract(`creditLine.${t}`, "BorrowDeskStockfill", [
      d.vaults[t].vault,
      d.feeRouter,
      tl,
      roles.guardian,
      cl.risk,
      { baseRatePerYear: wad(cl.rates.baseRatePerYear), slope1PerYear: wad(cl.rates.slope1PerYear), slope2PerYear: wad(cl.rates.slope2PerYear), kinkUtilization: wad(cl.rates.kinkUtilization) },
      usdgUnits(cl.supplyCapUsdg),
      usdgUnits(cl.borrowCapUsdg),
      `Stockfill ${t} Credit Line`,
      `cl${t}`,
    ]);
    if ((await registry.indexPlusOne(desk)) === 0n) await tx(registry.list(desk, 1, t));
    d.creditLines[t] = await desk.getAddress();
  }
  console.log(`Credit lines: ${Object.keys(d.creditLines).join(" ") || "none"}`);

  // ---------------------------------------------------------------- Basket
  // BasketStockfill refuses admin == guardian at construction. The deployer is its admin while it lists the Vaults and
  // opens its cap, so the guardian (the same dev wallet) is parked on the timelock and moved over right after.
  const basket = await contract("basket", "BasketStockfill", [env.usdg, me, same(roles.guardian, me) ? tl : roles.guardian, roles.keeper, "Stockfill Basket", "sfBASKET"]);
  d.basketProgram = await basket.getAddress();
  if (await basket.hasRole(ADMIN, me)) {
    for (const t of vaultTickers.slice(0, 8)) if (!(await basket.isListed(d.vaults[t].vault))) await tx(basket.listVault(d.vaults[t].vault));
    if (!live && (await basket.heldValueCap()) !== usdgUnits(L.basketCapUsdg)) await tx(basket.setHeldValueCap(usdgUnits(L.basketCapUsdg)));
    const GUARDIAN = await basket.GUARDIAN_ROLE();
    if (!(await basket.hasRole(GUARDIAN, roles.guardian))) await tx(basket.grantRole(GUARDIAN, roles.guardian));
    if (!same(roles.guardian, tl) && (await basket.hasRole(GUARDIAN, tl))) await tx(basket.revokeRole(GUARDIAN, tl));
  }
  if ((await registry.indexPlusOne(basket)) === 0n) await tx(registry.list(basket, 2, "BASKET"));
  if (live) openCaps.push({ target: d.basketProgram, cap: usdgUnits(L.basketCapUsdg).toString() });

  // ---------------------------------------------------------------- hand settings to the timelock
  console.log("Handing governance to the timelock");
  for (const c of [buyBurn, basket]) {
    if (await c.hasRole(ADMIN, me)) {
      if (!(await c.hasRole(ADMIN, tl))) await tx(c.grantRole(ADMIN, tl));
      await tx(c.renounceRole(ADMIN, me));
    }
  }
  const ownables = live ? [swap, oracle, registry] : [oracle, registry];
  for (const c of ownables) {
    const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
    if (!same(owner, tl) && !same(pending, tl)) await tx(c.transferOwnership(tl));
  }
  d.pendingTimelockAcceptances = await Promise.all(ownables.map((c) => c.getAddress()));
  d.openCaps = openCaps;
  console.log(`  ${vaultTickers.length} Vaults, ${Object.keys(d.creditLines).length} credit lines and the Basket (${sent} transactions this run)`);
  return { d, sent, env };
}

/** The live markets: Chainlink feeds and the hookless pools probe-pools found (config/robinhood.pools.json). */
function liveEnv(progress = {}) {
  const pools = require("../config/robinhood.pools.json");
  const equity = {};
  for (const t of L.vaults) {
    const s = config.equityTokens[t];
    if (!s) throw new Error(`Unknown stock ${t} in config/robinhood.json`);
    const p = pools[t] && pools[t].pool;
    // A Vault an earlier run already deployed stays in, whatever its pool looks like now.
    const started = progress[`vault.${t}`] || progress[`position.${t}`];
    if (started && p) {
      equity[t] = { address: s.address, feed: s.chainlinkFeed, name: s.name, fee: p.fee, tickSpacing: p.tickSpacing };
      continue;
    }
    if (!p || !p.liquidity || BigInt(p.liquidity) < BigInt(L.poolMinLiquidity)) {
      console.log(`  ${t.padEnd(6)} skipped: no hookless ${t}/USDG pool with enough liquidity right now`);
      continue;
    }
    // A Vault's swaps may lose at most 1% against Chainlink, so a pool whose fee alone is near that can never be used.
    if (Number(p.fee) > L.poolMaxFee) {
      console.log(`  ${t.padEnd(6)} skipped: its pool charges ${Number(p.fee) / 10_000}% a swap, too close to the 1% swap-loss limit`);
      continue;
    }
    equity[t] = { address: s.address, feed: s.chainlinkFeed, name: s.name, fee: p.fee, tickSpacing: p.tickSpacing };
  }
  return { usdg: config.tokens.usdg.address, usdgFeed: config.chainlink.usdgUsdFeed, sequencerFeed: config.chainlink.sequencerUptimeFeed || ethers.ZeroAddress, equity };
}

/** Local demo: mock USDG, Stock Tokens, feeds and a mock swap venue that trades them at fixed prices. */
async function localEnv(signer, progress, remember) {
  if (progress.localEnv) return progress.localEnv;
  const deploy = async (name, args) => {
    const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const usdgFeed = await deploy("MockAggregator", [8, 100_000_000]);
  const swap = await deploy("MockSwapAdapter", []);
  await send(usdg.mint(swap, usdgUnits(100_000_000)));
  const equity = {};
  for (const t of L.vaults) {
    const price = DEMO_PRICES[t];
    const name = config.equityTokens[t].name;
    const token = await deploy("MockStockToken", [name, t]);
    const feed = await deploy("MockAggregator", [8, Math.round(price * 1e8)]);
    await send(token.mint(swap, wad(1_000_000)));
    await send(swap.setRate(token, usdg, usdgUnits(price)));
    await send(swap.setRate(usdg, token, 10n ** 36n / usdgUnits(price)));
    equity[t] = { address: await token.getAddress(), feed: await feed.getAddress(), name };
  }
  const env = { usdg: await usdg.getAddress(), usdgFeed: await usdgFeed.getAddress(), sequencerFeed: ethers.ZeroAddress, swap: await swap.getAddress(), equity };
  remember("localEnv", env);
  return env;
}

module.exports = { deployStockfill, poolKey, DEMO_PRICES };
