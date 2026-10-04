import type { Address } from "viem";
import { NATIVE, HopKind, type ChainConfig, type Hop, type Path, type Pool } from "./types.js";

const lower = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lower(a) === lower(b);

export type PathOptions = {
  maxPoolHops?: number; // default 3
  maxPoolsPerPair?: number; // default 3, deepest first
  maxPaths?: number; // default 32
  symbol?: (a: Address) => string;
};

const MAX_HOPS = 4; // RouterStockfill.MAX_HOPS

export function feeLabel(p: Pool): string {
  const pct = p.fee / 10000;
  return `v${p.version} ${pct}%`;
}

/**
 * Every sensible way to get from tokenIn to tokenOut: direct, or through the hubs (USDG, WETH/ETH),
 * up to three pools, with ETH<->WETH conversions inserted wherever a v4 native-ETH pool meets a
 * WETH pool. No pool is used twice in one path.
 */
export function buildPaths(tokenIn: Address, tokenOut: Address, pools: Pool[], cfg: ChainConfig, opts: PathOptions = {}): Path[] {
  const maxPoolHops = opts.maxPoolHops ?? 3;
  const perPair = opts.maxPoolsPerPair ?? 3;
  const maxPaths = opts.maxPaths ?? 32;
  const sym = opts.symbol ?? ((a: Address) => (same(a, NATIVE) ? "ETH" : a.slice(0, 6)));
  const weth = cfg.weth;
  const isEth = (a: Address) => same(a, NATIVE) || same(a, weth);
  const norm = (a: Address) => (isEth(a) ? lower(NATIVE) : lower(a));
  const hubs = new Set([lower(NATIVE), ...cfg.hubs.map(norm)]);

  // ETH <-> WETH needs no pool at all.
  if (isEth(tokenIn) && isEth(tokenOut) && !same(tokenIn, tokenOut)) {
    const wrap = same(tokenIn, NATIVE);
    return [
      {
        hops: [conv(wrap ? HopKind.WRAP : HopKind.UNWRAP, wrap ? weth : NATIVE)],
        pools: [],
        tokens: [tokenIn, tokenOut],
        label: wrap ? "Wrap ETH" : "Unwrap WETH",
      },
    ];
  }

  // For each normalised pair, keep the deepest few pools.
  const byPair = new Map<string, Pool[]>();
  for (const p of pools) {
    const k = [norm(p.token0), norm(p.token1)].sort().join("-");
    byPair.set(k, [...(byPair.get(k) ?? []), p]);
  }
  const allowed = new Set<string>();
  for (const group of byPair.values()) {
    group
      .slice()
      .sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0))
      .slice(0, perPair)
      .forEach((p) => allowed.add(p.id));
  }
  const usable = pools.filter((p) => allowed.has(p.id));

  const results: Path[] = [];

  const walk = (current: Address, hops: Hop[], used: string[], visited: string[], tokens: Address[], labels: string[]) => {
    if (used.length >= maxPoolHops) return;
    for (const p of usable) {
      if (used.includes(p.id)) continue;
      // Which side of the pool `current` enters on, treating ETH and WETH as one.
      let side: 0 | 1 | null = null;
      if (norm(p.token0) === norm(current)) side = 0;
      else if (norm(p.token1) === norm(current)) side = 1;
      if (side === null) continue;
      const poolIn = side === 0 ? p.token0 : p.token1;
      const poolOut = side === 0 ? p.token1 : p.token0;
      if (visited.includes(norm(poolOut))) continue;

      const nextHops = [...hops];
      if (!same(poolIn, current)) {
        // `current` is ETH and the pool holds WETH, or the other way round.
        nextHops.push(same(current, NATIVE) ? conv(HopKind.WRAP, weth) : conv(HopKind.UNWRAP, NATIVE));
      }
      nextHops.push({
        kind: p.version === 3 ? HopKind.V3 : HopKind.V4,
        tokenOut: poolOut,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hooks: p.hooks,
      });
      const nextUsed = [...used, p.id];
      const nextTokens = [...tokens, poolOut];
      const nextLabels = [...labels, `${sym(poolOut)} (${feeLabel(p)})`];

      if (norm(poolOut) === norm(tokenOut)) {
        const finalHops = [...nextHops];
        const finalLabels = [...nextLabels];
        if (!same(poolOut, tokenOut)) {
          finalHops.push(same(tokenOut, NATIVE) ? conv(HopKind.UNWRAP, NATIVE) : conv(HopKind.WRAP, weth));
          finalLabels[finalLabels.length - 1] = `${sym(tokenOut)} (${feeLabel(p)})`;
        }
        if (finalHops.length <= MAX_HOPS) {
          results.push({
            hops: finalHops,
            pools: nextUsed,
            tokens: [...nextTokens.slice(0, -1), tokenOut],
            label: [sym(tokenIn), ...finalLabels].join(" → "),
          });
        }
        continue;
      }
      // Only hubs may sit in the middle of a path.
      if (!hubs.has(norm(poolOut))) continue;
      if (nextHops.length >= MAX_HOPS) continue;
      walk(poolOut, nextHops, nextUsed, [...visited, norm(poolOut)], nextTokens, nextLabels);
    }
  };

  walk(tokenIn, [], [], [norm(tokenIn)], [tokenIn], []);

  // Fewer pools first: less fee, less gas.
  results.sort((a, b) => a.pools.length - b.pools.length);
  return dedupe(results).slice(0, maxPaths);
}

function conv(kind: HopKind.WRAP | HopKind.UNWRAP, out: Address): Hop {
  return { kind, tokenOut: out, fee: 0, tickSpacing: 0, hooks: NATIVE };
}

function dedupe(paths: Path[]): Path[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const k = p.pools.join("|") + "#" + p.hops.map((h) => h.kind).join("");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** True if two paths touch no pool in common (so their quotes can be added up). */
export function disjoint(a: Path, b: Path): boolean {
  return !a.pools.some((p) => b.pools.includes(p));
}
