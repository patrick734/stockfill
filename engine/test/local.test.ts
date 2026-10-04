/**
 * Integration test: the engine against a local anvil chain holding real Uniswap v3 and v4 code
 * (deployed by contracts/script/LocalWorld.s.sol). Finds routes, executes them through the real
 * router, and checks that the account received exactly what was quoted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  NATIVE,
  discoverV4Pools,
  erc20Abi,
  findRoute,
  marketSnapshot,
  permit2TypedData,
  permitTypedData,
  randomPermit2Nonce,
  readPermitDomain,
  routerAbi,
  splitSignature,
  swapCall,
  tradeArgs,
  type ChainConfig,
  type Plan,
} from "../src/index.js";

const w = JSON.parse(readFileSync(new URL("../../contracts/local-world.json", import.meta.url), "utf8")) as Record<string, Address>;
// anvil's well-known dev key #0 (public, local only).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
// Works whatever chain id the local node uses (31337 by default, or 4663 to mirror Robinhood Chain).
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663);
const local = defineChain({
  id: CHAIN_ID,
  name: "local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? "http://127.0.0.1:8545"] } },
});
const client = createPublicClient({ chain: local, transport: http() });
const wallet = createWalletClient({ chain: local, transport: http(), account });

const cfg: ChainConfig = {
  chainId: CHAIN_ID,
  v3Factory: w.v3Factory,
  poolManager: w.poolManager,
  weth: w.weth,
  hubs: [w.usdg],
  quoter: w.quoter,
  router: w.router,
};
const names: Record<string, string> = Object.fromEntries(
  Object.entries(w).map(([k, v]) => [v.toLowerCase(), k.toUpperCase()]),
);
const symbol = (a: Address) => (a === NATIVE ? "ETH" : names[a.toLowerCase()] ?? a.slice(0, 6));

const balance = (token: Address) =>
  token === NATIVE
    ? client.getBalance({ address: account.address })
    : client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

/** Executes a plan; returns what the account received and what it paid. */
async function trade(plan: Plan) {
  const [outBefore, inBefore] = await Promise.all([balance(plan.tokenOut), balance(plan.tokenIn)]);
  const call = swapCall(plan, account.address);
  const hash = await wallet.writeContract({ address: cfg.router!, abi: routerAbi, ...call } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success");
  const gas = r.gasUsed * r.effectiveGasPrice;
  const [outAfter, inAfter] = await Promise.all([balance(plan.tokenOut), balance(plan.tokenIn)]);
  return {
    got: outAfter - outBefore + (plan.tokenOut === NATIVE ? gas : 0n),
    paid: inBefore - inAfter - (plan.tokenIn === NATIVE ? gas : 0n),
  };
}

const execute = async (plan: Plan) => (await trade(plan)).got;

async function routerIsEmpty() {
  for (const t of [w.usdg, w.nvda, w.tsla, w.meme, w.weth]) {
    const b = await client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [cfg.router!] });
    assert.equal(b, 0n, `router kept ${symbol(t)}`);
  }
  assert.equal(await client.getBalance({ address: cfg.router! }), 0n, "router kept ETH");
}

function show(name: string, plan: Plan) {
  console.log(`\n${name}: ${plan.amountIn} ${symbol(plan.tokenIn)} for ${plan.amountOut} ${symbol(plan.tokenOut)}`);
  for (const l of plan.legs) console.log(`   ${l.share.toFixed(0).padStart(3)}%  ${l.path.label}`);
  console.log(`   split gain ${plan.splitGainBps} bps · impact ${plan.impactBps} bps · ${plan.pathsConsidered} paths considered`);
}

async function main() {
  const latest = await client.getBlockNumber();
  const v4Pools = await discoverV4Pools(client, cfg, 0n, latest);
  assert.equal(v4Pools.length, 3, "found all v4 pools from Initialize events");

  // 0. Market board (before any swap moves prices): prices from real tiny quotes, venue counts, and a $1k probe.
  {
    const rows = await marketSnapshot(client, cfg, w.usdg, [
      { address: w.nvda, decimals: 18 },
      { address: w.tsla, decimals: 18 },
      { address: w.aapl, decimals: 18 },
      { address: w.meme, decimals: 18 },
    ], v4Pools, 1000, symbol);
    for (const r of rows) console.log(`   ${symbol(r.token)}  $${r.price?.toFixed(4)}  v3:${r.venues.v3} v4:${r.venues.v4}  $1k impact ${r.probeImpactBps}bps  ${r.bestLabel}`);
    assert.ok(rows.every((r) => r.price && r.price > 0), "every token priced");
    assert.equal(rows[0].venues.v3 + rows[0].venues.v4, 3, "NVDA has three USDG venues");
    assert.ok(Math.abs(rows[0].price! - 180) < 1, "NVDA ≈ $180");
    assert.ok(Math.abs(rows[2].price! - 230) < 2, "AAPL ≈ $230");
    assert.ok(rows[3].bestLabel?.includes("ETH"), "the meme routes through ETH");
  }

  // 1. Big trade: must split across venues and beat the best single path.
  {
    const { plan, pools } = await findRoute(client, cfg, { tokenIn: w.usdg, tokenOut: w.nvda, amountIn: 600_000n * 10n ** 6n, v4Pools, symbol });
    assert.ok(plan);
    show("big USDG to NVDA", plan);
    assert.ok(plan.legs.length > 1, "big trade splits");
    assert.ok(plan.splitGainBps > 0, "split beats best single path");
    const got = await execute(plan);
    assert.equal(got, plan.amountOut, "received exactly the quote");
    assert.ok(pools.length > 0);
    await routerIsEmpty();
  }

  // 2. Small trade: one path is enough.
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: w.usdg, tokenOut: w.nvda, amountIn: 100n * 10n ** 6n, v4Pools, symbol });
    assert.ok(plan);
    show("small USDG to NVDA", plan);
    assert.equal(plan.legs.length, 1);
    assert.equal(await execute(plan), plan.amountOut);
  }

  // 3. ETH to MEME: the native v4 pool, or a wrap and the v3 WETH pool, or both.
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: NATIVE, tokenOut: w.meme, amountIn: parseEther("30"), v4Pools, symbol });
    assert.ok(plan);
    show("ETH to MEME", plan);
    assert.equal(await execute(plan), plan.amountOut);
    await routerIsEmpty();
  }

  // 4. MEME to native ETH.
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: w.meme, tokenOut: NATIVE, amountIn: parseEther("1000000"), v4Pools, symbol });
    assert.ok(plan);
    show("MEME to ETH", plan);
    assert.equal(await execute(plan), plan.amountOut);
    await routerIsEmpty();
  }

  // 5. Stock to stock through USDG; the drifted USDG/TSLA pool (2x off) must never be used.
  {
    const { plan, pools } = await findRoute(client, cfg, { tokenIn: w.nvda, tokenOut: w.tsla, amountIn: parseEther("10"), v4Pools, symbol });
    assert.ok(plan);
    show("NVDA to TSLA", plan);
    const drifted = pools.find((p) => p.version === 3 && p.fee === 3000 && [p.token0, p.token1].map((x) => x.toLowerCase()).includes(w.tsla.toLowerCase()));
    assert.equal(drifted, undefined, "drifted pool filtered out");
    assert.equal(await execute(plan), plan.amountOut);
  }

  // 6. ETH to WETH needs no pool.
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: NATIVE, tokenOut: w.weth, amountIn: parseEther("1"), v4Pools, symbol });
    assert.ok(plan);
    assert.equal(plan.amountOut, parseEther("1"));
    assert.equal(await execute(plan), parseEther("1"));
    await routerIsEmpty();
  }

  // 7. Slippage: minAmountOut sits slippageBps under the quote (1% here).
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: w.usdg, tokenOut: w.tsla, amountIn: 5_000_000n, v4Pools, symbol, slippageBps: 100 });
    assert.ok(plan);
    assert.equal(plan.minAmountOut, (plan.amountOut * 9900n) / 10000n);
  }

  // 8. Deployless quoting (no quoter deployed) gives exactly the same answer.
  {
    const req = { tokenIn: w.usdg, tokenOut: w.nvda, amountIn: 400_000n * 10n ** 6n, v4Pools, symbol };
    const a = await findRoute(client, cfg, req);
    const b = await findRoute(client, { ...cfg, quoter: undefined }, req);
    assert.ok(a.plan && b.plan);
    assert.equal(b.plan.amountOut, a.plan.amountOut, "deployless quote = deployed quote");
    assert.equal(b.plan.legs.length, a.plan.legs.length);
    console.log(`\ndeployless quote matches: ${b.plan.amountOut}`);
  }

  // 9. Buy exactly: a big trade splits, costs exactly the quote and refunds the rest of the maximum.
  {
    const amountOut = 2_000n * 10n ** 18n;
    const { plan } = await findRoute(client, cfg, { tokenIn: w.usdg, tokenOut: w.nvda, amountOut, v4Pools, symbol });
    assert.ok(plan);
    show("buy exactly 2,000 NVDA", plan);
    assert.ok(plan.exactOut);
    assert.ok(plan.legs.length > 1, "big exact-output trade splits");
    assert.ok(plan.maxAmountIn > plan.amountIn);
    const { got, paid } = await trade(plan);
    assert.equal(got, amountOut, "received exactly the amount asked for");
    assert.equal(paid, plan.amountIn, "paid exactly the quote");
    await routerIsEmpty();
  }

  // 10. Buy exactly with ETH: unused ETH comes back.
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: NATIVE, tokenOut: w.meme, amountOut: parseEther("500000"), v4Pools, symbol });
    assert.ok(plan);
    show("buy exactly 500k MEME with ETH", plan);
    const { got, paid } = await trade(plan);
    assert.equal(got, parseEther("500000"));
    assert.equal(paid, plan.amountIn);
    await routerIsEmpty();
  }

  // 11. Buy exactly 1 ETH.
  {
    const { plan } = await findRoute(client, cfg, { tokenIn: w.meme, tokenOut: NATIVE, amountOut: parseEther("1"), v4Pools, symbol });
    assert.ok(plan);
    const { got, paid } = await trade(plan);
    assert.equal(got, parseEther("1"));
    assert.equal(paid, plan.amountIn);
    await routerIsEmpty();
  }

  // 12. One signature instead of an approval: EIP-2612 permit, then Permit2.
  {
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const signerWallet = createWalletClient({ chain: local, transport: http(), account: signer });
    const fund = await wallet.writeContract({ address: w.usdg, abi: erc20Abi, functionName: "transfer", args: [signer.address, 10_000n * 10n ** 6n] });
    await client.waitForTransactionReceipt({ hash: fund });
    const nvdaOf = () => client.readContract({ address: w.nvda, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] });

    const { plan } = await findRoute(client, cfg, { tokenIn: w.usdg, tokenOut: w.nvda, amountIn: 1_000n * 10n ** 6n, v4Pools, symbol });
    assert.ok(plan);
    const permit = await readPermitDomain(client, w.usdg, signer.address, CHAIN_ID);
    assert.ok(permit, "the USDG mock supports EIP-2612");
    const { trade: t, legs, pull } = tradeArgs(plan, signer.address);
    const deadline = t.deadline;
    const sig = await signerWallet.signTypedData(
      permitTypedData({ domain: permit.domain, owner: signer.address, spender: cfg.router!, value: pull, nonce: permit.nonce, deadline }),
    );
    const { v, r, s } = splitSignature(sig);
    let hash = await signerWallet.writeContract({
      address: cfg.router!,
      abi: routerAbi,
      functionName: "swapWithPermit",
      args: [t, legs, { value: pull, deadline, v, r, s }],
    });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal(await nvdaOf(), plan.amountOut, "permit swap delivered the quote");

    hash = await signerWallet.writeContract({ address: w.usdg, abi: erc20Abi, functionName: "approve", args: [w.permit2, 2n ** 256n - 1n] });
    await client.waitForTransactionReceipt({ hash });
    const exact = await findRoute(client, cfg, { tokenIn: w.usdg, tokenOut: w.nvda, amountOut: 5n * 10n ** 18n, v4Pools, symbol });
    assert.ok(exact.plan);
    const p2 = tradeArgs(exact.plan, signer.address);
    const nonce = randomPermit2Nonce();
    const sig2 = await signerWallet.signTypedData(
      permit2TypedData({ chainId: CHAIN_ID, token: w.usdg, amount: p2.pull, spender: cfg.router!, nonce, deadline: p2.trade.deadline, permit2: w.permit2 }),
    );
    const before = await nvdaOf();
    hash = await signerWallet.writeContract({
      address: cfg.router!,
      abi: routerAbi,
      functionName: "swapWithPermit2",
      args: [p2.trade, p2.legs, { amount: p2.pull, nonce, deadline: p2.trade.deadline, signature: sig2 }],
    });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal((await nvdaOf()) - before, 5n * 10n ** 18n, "Permit2 exact-output swap delivered exactly 5 NVDA");
    await routerIsEmpty();
    console.log("\npermit and Permit2 swaps: ok");
  }

  console.log("\nengine integration: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
