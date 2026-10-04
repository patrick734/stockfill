import type { Address, PublicClient } from "viem";
import { loadV4Pools } from "./pools.js";
import { NATIVE, type ChainConfig, type V4PoolKey } from "./types.js";

/** The standard (fee, tickSpacing) pairs Uniswap v4 pools are created with. */
export const V4_STANDARD_TIERS: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

/**
 * Finds hook-free v4 pools between each token and the hubs without reading any event history:
 * every standard pool key is derived, and PoolManager storage says which ones exist. Pools with
 * hooks or unusual fee tiers are not found this way (they need the Initialize event history).
 */
export async function probeV4Pools(
  client: PublicClient,
  cfg: ChainConfig,
  tokens: Address[],
  hubs: Address[],
  tiers: [number, number][] = V4_STANDARD_TIERS,
): Promise<V4PoolKey[]> {
  const keys: V4PoolKey[] = [];
  const seen = new Set<string>();
  const all = [...hubs, ...tokens];
  for (const t of all) {
    for (const h of hubs) {
      if (t.toLowerCase() === h.toLowerCase()) continue;
      const [c0, c1] = t.toLowerCase() < h.toLowerCase() ? [t, h] : [h, t];
      for (const [fee, tickSpacing] of tiers) {
        const k = `${c0}-${c1}-${fee}-${tickSpacing}`.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: NATIVE });
      }
    }
  }
  const found: V4PoolKey[] = [];
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const live = await loadV4Pools(client, cfg, chunk);
    const ids = new Set(live.map((p) => `${p.token0}-${p.token1}-${p.fee}-${p.tickSpacing}`.toLowerCase()));
    for (const k of chunk) if (ids.has(`${k.currency0}-${k.currency1}-${k.fee}-${k.tickSpacing}`.toLowerCase())) found.push(k);
  }
  return found;
}
