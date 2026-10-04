import { zeroAddress, type Address } from "viem";

/** Native ETH, the same convention Uniswap v4 and the router use. */
export const NATIVE: Address = zeroAddress;

/** Mirrors HopKind in RouteTypes.sol. */
export enum HopKind {
  V3 = 0,
  V4 = 1,
  WRAP = 2,
  UNWRAP = 3,
}

export type Hop = {
  kind: HopKind;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type ChainConfig = {
  chainId: number;
  v3Factory: Address;
  poolManager: Address;
  weth: Address;
  /** Hub tokens a path may pass through (besides WETH/ETH, which are always hubs). */
  hubs: Address[];
  /** QuoterStockfill. Undefined quotes "deployless": the quoter's creation code runs inside eth_call. */
  quoter?: Address;
  /** RouterStockfill. Undefined means quotes only. */
  router?: Address;
  multicall3?: Address;
};

export type Pool = {
  version: 3 | 4;
  /** v3: pool address. v4: poolId. */
  id: `0x${string}`;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
};

/** A v4 pool as stored by the indexer (state is read live). */
export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type Path = {
  hops: Hop[];
  /** Pools used, in order (ids). Two paths can share a split only if these don't overlap. */
  pools: string[];
  /** Tokens visited, tokenIn first. */
  tokens: Address[];
  /** Display label: the tokens visited, joined by arrows, each with the venue and fee of the pool that reached it. */
  label: string;
};

export type PlanLeg = { path: Path; amountIn: bigint; amountOut: bigint; share: number };

export type Plan = {
  tokenIn: Address;
  tokenOut: Address;
  /** True when `amountOut` is the fixed side (buy exactly), false when `amountIn` is (sell exactly). */
  exactOut: boolean;
  amountIn: bigint;
  amountOut: bigint;
  /** Exact input: the least the swap may return. Exact output: equal to `amountOut`. */
  minAmountOut: bigint;
  /** Exact output: the most the swap may cost. Exact input: equal to `amountIn`. */
  maxAmountIn: bigint;
  legs: PlanLeg[];
  /** Best single path at the full size, for comparison. */
  bestSingle: { path: Path; amountIn: bigint; amountOut: bigint } | null;
  /** What the split gains over the best single path, in basis points: more out, or less in. */
  splitGainBps: number;
  /** Price impact vs. a tiny trade on the best path, in basis points. */
  impactBps: number;
  pathsConsidered: number;
  quotedAt: number;
};
