/**
 * Builds the app's token list from Robinhood's own public Stock Token registry, then keeps the
 * ones that actually trade on Uniswap on Robinhood Chain. No event history, no API key.
 *
 *   RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key> OUT_DIR=../web/public/data npm run tokens
 *
 * Steps:
 *  1. read every Stock Token and its address from https://api.robinhood.com/rhj/assets (public, read-only)
 *  2. keep deployments on chain 4663, confirm each one on-chain (same beacon as a known Stock Token)
 *  3. find its pools: Uniswap v3 against USDG/WETH (all fee tiers) and standard v4 pools vs USDG/ETH/WETH
 *  4. write tokens.json and v4pools.json (logos are resolved in the app by ticker)
 *
 * ALL_TOKENS=1 keeps Stock Tokens that have no pool yet (they show as "no pool yet" in the app).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, getAddress, http, zeroAddress, type Address, type PublicClient } from "viem";
import { erc20Abi } from "../src/abi.js";
import { loadV3Pools } from "../src/pools.js";
import { ROBINHOOD, robinhoodConfig } from "../src/robinhood.js";
import { NATIVE } from "../src/types.js";
import { probeV4Pools } from "../src/v4probe.js";

const RPC = process.env.RPC_URL;
if (!RPC) throw new Error("set RPC_URL");
const OUT = process.env.OUT_DIR ?? "./out";
const REGISTRY = process.env.REGISTRY_URL ?? "https://api.robinhood.com/rhj/assets";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? ROBINHOOD.chainId);
const VERIFY = process.env.VERIFY_BEACON !== "0";
const KEEP_ALL = process.env.ALL_TOKENS === "1";

const client = createPublicClient({ transport: http(RPC, { batch: true, retryCount: 4 }) }) as PublicClient;
const cfg = {
  ...robinhoodConfig(),
  ...(process.env.V3_FACTORY ? { v3Factory: process.env.V3_FACTORY as Address } : {}),
  ...(process.env.POOL_MANAGER ? { poolManager: process.env.POOL_MANAGER as Address } : {}),
  ...(process.env.WETH ? { weth: process.env.WETH as Address } : {}),
  ...(process.env.NO_MULTICALL === "1" ? { multicall3: undefined } : {}),
};
const USDG = (process.env.USDG as Address | undefined) ?? ROBINHOOD.usdg;
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const lower = (a: string) => a.toLowerCase();

type Asset = {
  tokenSymbol?: string;
  tokenName?: string;
  status?: string;
  logoUrl?: string;
  deployments?: { contractAddress?: string; chainId?: number | string }[];
};

async function beaconOf(a: Address): Promise<string> {
  const v = await client.getStorageAt({ address: a, slot: BEACON_SLOT }).catch(() => undefined);
  return v && BigInt(v) !== 0n ? lower(`0x${v.slice(-40)}`) : "";
}

async function main() {
  // 1. Robinhood's registry
  const res = await fetch(REGISTRY, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const body = (await res.json()) as { assets?: Asset[]; results?: Asset[] } | Asset[];
  const assets: Asset[] = Array.isArray(body) ? body : (body.assets ?? body.results ?? []);
  console.log(`registry: ${assets.length} assets`);

  const listed = new Map<string, { address: Address; symbol: string; name: string; status?: string }>();
  for (const a of assets) {
    const d = a.deployments?.find((x) => Number(x.chainId) === CHAIN_ID && x.contractAddress);
    if (!d || !a.tokenSymbol) continue;
    if (a.status && /delist|inactive|disabled|halt|deprecat/i.test(a.status)) continue;
    const address = getAddress(d.contractAddress!);
    // Registry names end in "• Robinhood Token"; the app shows the company name only. The registry
    // logo is the same Robinhood mark for every token, so the app uses company logos by ticker instead.
    const name = (a.tokenName ?? a.tokenSymbol).replace(/\s*[•·|-]\s*Robinhood\s+Token\s*$/i, "").trim();
    listed.set(lower(address), { address, symbol: a.tokenSymbol, name, status: a.status });
  }
  console.log(`  on chain ${CHAIN_ID}: ${listed.size}`);

  // 2. Confirm on-chain: every official Stock Token points at the same beacon as a known one.
  let stocks = [...listed.values()];
  if (VERIFY) {
    const ref = await beaconOf(ROBINHOOD.referenceStock);
    if (!ref) throw new Error("reference Stock Token has no beacon; set VERIFY_BEACON=0 to skip this check");
    const beacons = await Promise.all(stocks.map((s) => beaconOf(s.address)));
    const before = stocks.length;
    stocks = stocks.filter((_, i) => beacons[i] === ref);
    console.log(`  confirmed on-chain: ${stocks.length}/${before}`);
  }

  // 3. Pools
  const pairs: [Address, Address][] = stocks.flatMap((s) => [
    [s.address, USDG] as [Address, Address],
    [s.address, cfg.weth] as [Address, Address],
  ]);
  const v3 = await loadV3Pools(client, cfg, pairs);
  const v3Count = new Map<string, number>();
  for (const p of v3) {
    if (p.liquidity === 0n) continue;
    for (const t of [p.token0, p.token1]) v3Count.set(lower(t), (v3Count.get(lower(t)) ?? 0) + 1);
  }
  const v4 = await probeV4Pools(client, cfg, stocks.map((s) => s.address), [USDG, NATIVE, cfg.weth]);
  const v4Count = new Map<string, number>();
  for (const k of v4) for (const t of [k.currency0, k.currency1]) v4Count.set(lower(t), (v4Count.get(lower(t)) ?? 0) + 1);
  console.log(`  v3 pools with liquidity: ${v3.filter((p) => p.liquidity > 0n).length} · v4 pools: ${v4.length}`);

  const tradable = stocks.filter((s) => (v3Count.get(lower(s.address)) ?? 0) + (v4Count.get(lower(s.address)) ?? 0) > 0);
  const keep = KEEP_ALL ? stocks : tradable;
  console.log(`  with at least one pool: ${tradable.length}${KEEP_ALL ? " (keeping all)" : ""}`);
  // A flaky RPC or a registry hiccup must never wipe the live list: stop before writing anything.
  if (keep.length === 0) throw new Error("no Stock Tokens found; keeping the existing tokens.json");

  // 4. Decimals + output
  const decimals = await Promise.all(
    keep.map((s) => client.readContract({ address: s.address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)),
  );
  const [usdgDec, wethDec] = await Promise.all([
    client.readContract({ address: USDG, abi: erc20Abi, functionName: "decimals" }).catch(() => 6),
    client.readContract({ address: cfg.weth, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
  ]);
  const tokens = [
    { address: zeroAddress, symbol: "ETH", name: "Ether", decimals: 18, kind: "base" },
    { address: USDG, symbol: "USDG", name: "Global Dollar", decimals: Number(usdgDec), kind: "base" },
    { address: cfg.weth, symbol: "WETH", name: "Wrapped Ether", decimals: Number(wethDec), kind: "base" },
    ...keep
      .map((s, i) => ({ address: s.address, symbol: s.symbol, name: s.name, decimals: Number(decimals[i]), kind: "stock" }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
  ];
  const keepSet = new Set([lower(USDG), lower(cfg.weth), lower(NATIVE), ...keep.map((s) => lower(s.address))]);
  const pools = v4.filter((k) => keepSet.has(lower(k.currency0)) && keepSet.has(lower(k.currency1)));

  mkdirSync(OUT, { recursive: true });
  const stamp = { updatedAt: new Date().toISOString(), source: REGISTRY };
  writeFileSync(join(OUT, "tokens.json"), JSON.stringify({ ...stamp, tokens }, null, 2));
  writeFileSync(join(OUT, "v4pools.json"), JSON.stringify({ ...stamp, pools }, null, 2));
  console.log(`wrote ${keep.length} Stock Tokens and ${pools.length} v4 pools to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
