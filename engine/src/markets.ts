import type { Address, PublicClient } from "viem";
import { buildPaths } from "./paths.js";
import { loadV3Pools, loadV4Pools, usablePools } from "./pools.js";
import { quoteJobs } from "./split.js";
import { NATIVE, type ChainConfig, type Path, type Pool, type V4PoolKey } from "./types.js";

export type MarketRow = {
  token: Address;
  /** USD per token, from a tiny real quote (USDG ≈ $1). Undefined if nothing trades. */
  price?: number;
  /** Tokens received for `probeUsd` dollars through the best single path, and the impact vs. `price`. */
  probeOut?: bigint;
  probeImpactBps?: number;
  venues: { v3: number; v4: number };
  /** Usable pools holding this token (v3 + v4), and the lowest fee tier among them (Uniswap units: 100 = 0.01%). */
  pools: number;
  minFee?: number;
  /** Best path at the probe size, for display ("via WETH", "direct v4 0.3%"). */
  bestLabel?: string;
};

const lower = (a: string) => a.toLowerCase();

/**
 * Live board for a list of tokens, all priced in USDG: one read for every pool, one batched
 * quote for every path. Numbers are what the pools would actually pay, not a price feed.
 */
export async function marketSnapshot(
  client: PublicClient,
  cfg: ChainConfig,
  usdg: Address,
  tokens: { address: Address; decimals: number }[],
  v4Pools: V4PoolKey[] = [],
  probeUsd = 1000,
  symbol?: (a: Address) => string,
): Promise<MarketRow[]> {
  const hubs = [usdg, cfg.weth, NATIVE];
  const pairs: [Address, Address][] = [[usdg, cfg.weth]];
  for (const t of tokens) for (const h of [usdg, cfg.weth]) pairs.push([t.address, h]);

  const wanted = new Set([...hubs, ...tokens.map((t) => t.address)].map(lower));
  const v4Keys = v4Pools.filter((k) => wanted.has(lower(k.currency0)) && wanted.has(lower(k.currency1)));
  const [v3, v4] = await Promise.all([loadV3Pools(client, cfg, pairs), loadV4Pools(client, cfg, v4Keys)]);
  const pools = usablePools([...v3, ...v4], cfg.weth);

  const tiny = 10n ** 6n; // $1 of USDG (6 decimals)
  const probe = BigInt(Math.round(probeUsd)) * 10n ** 6n;

  const allPaths: Path[] = [];
  const owner: number[] = []; // path index -> token index
  tokens.forEach((t, ti) => {
    const ps = buildPaths(usdg, t.address, pools, { ...cfg, hubs: [usdg] }, { maxPoolHops: 2, maxPaths: 6, symbol });
    for (const p of ps) {
      allPaths.push(p);
      owner.push(ti);
    }
  });

  const jobs = allPaths.flatMap((_, p) => [
    { path: p, amount: tiny },
    { path: p, amount: probe },
  ]);
  const q = allPaths.length ? await quoteJobs(client, cfg, usdg, allPaths, jobs) : [];

  // ETH and WETH are one asset here: a WETH row counts native-ETH v4 pools too.
  const summary = (addr: Address) => {
    const ids = lower(addr) === lower(cfg.weth) ? [lower(addr), lower(NATIVE)] : [lower(addr)];
    const touching = (p: Pool) => ids.includes(lower(p.token0)) || ids.includes(lower(p.token1));
    const mine = pools.filter(touching);
    const venues = { v3: mine.filter((p) => p.version === 3).length, v4: mine.filter((p) => p.version === 4).length };
    const minFee = mine.length ? Math.min(...mine.map((p) => p.fee)) : undefined;
    return { venues, pools: mine.length, minFee };
  };

  const rows: MarketRow[] = tokens.map((t, ti) => {
    const { venues, pools: poolCount, minFee } = summary(t.address);
    let bestTiny = 0n;
    let bestProbe = 0n;
    let bestLabel: string | undefined;
    allPaths.forEach((path, p) => {
      if (owner[p] !== ti) return;
      const small = q[p * 2];
      const big = q[p * 2 + 1];
      if (small > bestTiny) bestTiny = small;
      if (big > bestProbe) {
        bestProbe = big;
        bestLabel = path.label;
      }
    });
    if (bestTiny === 0n) return { token: t.address, venues, pools: poolCount, minFee };
    const perToken = Number(bestTiny) / 10 ** t.decimals; // tokens for $1
    const price = 1 / perToken;
    const ideal = perToken * probeUsd;
    const got = Number(bestProbe) / 10 ** t.decimals;
    const probeImpactBps = bestProbe > 0n ? Math.max(0, Math.round((1 - got / ideal) * 10000)) : undefined;
    return { token: t.address, price, probeOut: bestProbe || undefined, probeImpactBps, venues, pools: poolCount, minFee, bestLabel };
  });
  // USDG itself: the hub every price is quoted in.
  rows.push({ token: usdg, price: 1, ...summary(usdg) });
  return rows;
}
