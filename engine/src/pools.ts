import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { poolManagerAbi, v3FactoryAbi, v3PoolAbi } from "./abi.js";
import { NATIVE, type ChainConfig, type Pool, type V4PoolKey } from "./types.js";

export const V3_FEES = [100, 500, 3000, 10000] as const;

const lower = (a: string) => a.toLowerCase();

/** Reads many contract calls at once: Multicall3 when the chain has it, batched eth_calls otherwise. */
export async function readMany<T>(
  client: PublicClient,
  cfg: ChainConfig,
  calls: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }[],
): Promise<(T | undefined)[]> {
  if (calls.length === 0) return [];
  if (cfg.multicall3) {
    try {
      const res = await client.multicall({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contracts: calls as any,
        allowFailure: true,
        multicallAddress: cfg.multicall3,
        batchSize: 1024 * 64,
      });
      // Every call failing usually means Multicall3 isn't there: fall back to plain calls.
      if (res.some((r) => r.status === "success")) {
        return res.map((r) => (r.status === "success" ? (r.result as T) : undefined));
      }
    } catch {
      /* fall back below */
    }
  }
  return Promise.all(
    calls.map((c) =>
      client
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .readContract(c as any)
        .then((r) => r as T)
        .catch(() => undefined),
    ),
  );
}

/** Every Uniswap v3 pool (all fee tiers) for the given pairs, with live price and liquidity. */
export async function loadV3Pools(client: PublicClient, cfg: ChainConfig, pairs: [Address, Address][]): Promise<Pool[]> {
  const lookups: { a: Address; b: Address; fee: number }[] = [];
  const seen = new Set<string>();
  for (const [x, y] of pairs) {
    // v3 has no native ETH: pools hold WETH.
    const a = x === NATIVE ? cfg.weth : x;
    const b = y === NATIVE ? cfg.weth : y;
    if (lower(a) === lower(b)) continue;
    const [t0, t1] = lower(a) < lower(b) ? [a, b] : [b, a];
    for (const fee of V3_FEES) {
      const k = `${lower(t0)}-${lower(t1)}-${fee}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lookups.push({ a: t0, b: t1, fee });
    }
  }
  const addrs = await readMany<Address>(
    client,
    cfg,
    lookups.map((l) => ({ address: cfg.v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [l.a, l.b, l.fee] })),
  );
  const found = lookups
    .map((l, i) => ({ ...l, pool: addrs[i] }))
    .filter((l): l is typeof l & { pool: Address } => !!l.pool && l.pool !== zeroAddress);

  const state = await readMany<unknown>(
    client,
    cfg,
    found.flatMap((f) => [
      { address: f.pool, abi: v3PoolAbi, functionName: "slot0" },
      { address: f.pool, abi: v3PoolAbi, functionName: "liquidity" },
    ]),
  );

  const pools: Pool[] = [];
  found.forEach((f, i) => {
    const slot0 = state[i * 2] as readonly [bigint, ...unknown[]] | undefined;
    const liquidity = state[i * 2 + 1] as bigint | undefined;
    if (!slot0 || liquidity === undefined) return;
    pools.push({
      version: 3,
      id: f.pool,
      token0: f.a,
      token1: f.b,
      fee: f.fee,
      tickSpacing: 0,
      hooks: zeroAddress,
      sqrtPriceX96: slot0[0],
      liquidity,
    });
  });
  return pools;
}

export function v4PoolId(k: V4PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;

/** Live price and liquidity for known v4 pools, read straight from PoolManager storage. */
export async function loadV4Pools(client: PublicClient, cfg: ChainConfig, keys: V4PoolKey[]): Promise<Pool[]> {
  if (keys.length === 0) return [];
  const slots: `0x${string}`[] = [];
  const ids = keys.map(v4PoolId);
  for (const id of ids) {
    const state = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [id, POOLS_SLOT])));
    slots.push(`0x${state.toString(16).padStart(64, "0")}`);
    slots.push(`0x${(state + LIQUIDITY_OFFSET).toString(16).padStart(64, "0")}`);
  }
  const values = (await client.readContract({
    address: cfg.poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [slots],
  })) as `0x${string}`[];

  const pools: Pool[] = [];
  keys.forEach((k, i) => {
    const slot0 = BigInt(values[i * 2]);
    const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
    const liquidity = BigInt(values[i * 2 + 1]) & ((1n << 128n) - 1n);
    if (sqrtPriceX96 === 0n) return; // not initialized
    pools.push({
      version: 4,
      id: ids[i],
      token0: k.currency0,
      token1: k.currency1,
      fee: k.fee,
      tickSpacing: k.tickSpacing,
      hooks: k.hooks,
      sqrtPriceX96,
      liquidity,
    });
  });
  return pools;
}

/** Finds v4 pools for the given tokens from PoolManager's Initialize events (used by the indexer). */
export async function discoverV4Pools(
  client: PublicClient,
  cfg: ChainConfig,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 50_000n,
): Promise<V4PoolKey[]> {
  const out: V4PoolKey[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    const logs = await client.getContractEvents({
      address: cfg.poolManager,
      abi: poolManagerAbi,
      eventName: "Initialize",
      fromBlock: start,
      toBlock: end,
    });
    for (const l of logs) {
      const a = l.args as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
      out.push({ currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks });
    }
  }
  return out;
}

/** token1 per token0, in raw units (no decimals applied). */
export function midPrice(p: Pool): number {
  const s = Number(p.sqrtPriceX96) / 2 ** 96;
  return s * s;
}

/**
 * Keeps the pools a route may use: some liquidity at the current price, and a price within
 * `maxDeviation` (default 10%) of the deepest pool for the same pair (ETH and WETH pools count as
 * the same pair). A pool that has drifted away from the market is a trap, not a venue.
 */
export function usablePools(pools: Pool[], weth: Address, maxDeviation = 0.1): Pool[] {
  const byPair = new Map<string, Pool[]>();
  for (const p of pools) {
    if (p.liquidity === 0n) continue;
    const k = pairKey(p.token0, p.token1, weth);
    byPair.set(k, [...(byPair.get(k) ?? []), p]);
  }
  const keep: Pool[] = [];
  for (const group of byPair.values()) {
    // v3 and v4 liquidity are in the same units for the same pair, so the deepest is comparable.
    const deepest = group.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
    const ref = orientedPrice(deepest, weth);
    for (const p of group) {
      const dev = Math.abs(orientedPrice(p, weth) / ref - 1);
      if (dev <= maxDeviation) keep.push(p);
    }
  }
  return keep;
}

/** Mid price with ETH/WETH normalised, so a v4 ETH pool and a v3 WETH pool face the same way. */
function orientedPrice(p: Pool, weth: Address): number {
  const n = (x: Address) => (lower(x) === lower(weth) ? lower(NATIVE) : lower(x));
  const m = midPrice(p);
  return n(p.token0) < n(p.token1) ? m : 1 / m;
}

/** Pairs are keyed with WETH and ETH treated as the same asset (they convert 1:1 in a route). */
export function pairKey(a: Address, b: Address, weth?: Address): string {
  const n = (x: Address) => (weth && lower(x) === lower(weth) ? lower(NATIVE) : lower(x));
  const [x, y] = [n(a), n(b)].sort();
  return `${x}-${y}`;
}
