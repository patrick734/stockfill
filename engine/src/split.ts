import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, concatHex, type Address, type PublicClient } from "viem";
import { QUOTER_CREATION_CODE } from "./quoterCode.js";
import { quoterAbi } from "./abi.js";
import { disjoint } from "./paths.js";
import { NATIVE, type ChainConfig, type Hop, type Path, type Plan, type PlanLeg } from "./types.js";

export const TENTHS = 10;

export type SplitOptions = {
  /** Default 50 (0.5%). Lowers the minimum output, or raises the maximum input. */
  slippageBps?: number;
  /** Paths kept after the first full-size quote. Default 6. */
  shortlist?: number;
  /** Quotes per eth_call. Each one simulates real swaps, so keep batches modest. Default 40. */
  batchSize?: number;
  /** Default 10, the router's MAX_LEGS. */
  maxLegs?: number;
};

export type QuoteJob = { path: number; amount: bigint };

export const hopArg = (h: Hop) => ({
  kind: h.kind,
  tokenOut: h.tokenOut,
  fee: h.fee,
  tickSpacing: h.tickSpacing,
  hooks: h.hooks,
});

/**
 * Runs quote jobs through QuoterStockfill in batched eth_calls. Exact input jobs return outputs,
 * exact output jobs return inputs. A quote that cannot fill comes back as 0.
 */
export async function quoteJobs(
  client: PublicClient,
  cfg: ChainConfig,
  tokenIn: Address,
  paths: Path[],
  jobs: QuoteJob[],
  batchSize = 40,
  exactOut = false,
): Promise<bigint[]> {
  const functionName = exactOut ? "quoteManyExactOut" : "quoteMany";
  const out: bigint[] = new Array(jobs.length).fill(0n);
  const batches: { idx: number[]; paths: number[]; amounts: bigint[][] }[] = [];
  for (let i = 0; i < jobs.length; i += batchSize) {
    const slice = jobs.slice(i, i + batchSize);
    const pathIdx = [...new Set(slice.map((j) => j.path))];
    batches.push({
      idx: slice.map((_, k) => i + k),
      paths: pathIdx,
      amounts: pathIdx.map((p) => slice.filter((j) => j.path === p).map((j) => j.amount)),
    });
  }
  await Promise.all(
    batches.map(async (b) => {
      const data = encodeFunctionData({
        abi: quoterAbi,
        functionName,
        args: [tokenIn, b.paths.map((p) => paths[p].hops.map(hopArg)), b.amounts],
      });
      const ret = cfg.quoter
        ? await client.call({ to: cfg.quoter, data })
        : await client.call({ code: deploylessQuoter(cfg), data });
      const res = decodeFunctionResult({ abi: quoterAbi, functionName, data: ret.data! }) as readonly (readonly bigint[])[];
      const cursor = new Map<number, number>();
      for (const jobIndex of b.idx) {
        const pi = b.paths.indexOf(jobs[jobIndex].path);
        const c = cursor.get(pi) ?? 0;
        out[jobIndex] = res[pi][c];
        cursor.set(pi, c + 1);
      }
    }),
  );
  return out;
}

function deploylessQuoter(cfg: ChainConfig): `0x${string}` {
  return concatHex([
    QUOTER_CREATION_CODE,
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [cfg.v3Factory, cfg.poolManager, cfg.weth]),
  ]);
}

const tenth = (amount: bigint, k: number) => (amount * BigInt(k)) / BigInt(TENTHS);

/**
 * Finds the best way to fill a swap of `amount`, which is the input (sell exactly) or, with
 * `exactOut`, the output (buy exactly):
 *  1. quote every path at full size, and at a tiny size for the price-impact reference;
 *  2. quote the best few at every tenth of the amount;
 *  3. hand out the amount a tenth at a time to whichever path does best on that tenth (most output,
 *     or least input), combining only paths that share no pool so their quotes add up exactly;
 *  4. keep the split only if it beats the best single path, then quote the final legs exactly.
 */
export async function planSwap(
  client: PublicClient,
  cfg: ChainConfig,
  tokenIn: Address,
  tokenOut: Address,
  amount: bigint,
  paths: Path[],
  opts: SplitOptions & { exactOut?: boolean } = {},
): Promise<Plan | null> {
  if (amount <= 0n || paths.length === 0) return null;
  const exactOut = opts.exactOut ?? false;
  const slippageBps = opts.slippageBps ?? 50;
  const shortlistN = opts.shortlist ?? 6;
  const batchSize = opts.batchSize ?? 40;
  const maxLegs = opts.maxLegs ?? 10;
  const quote = (jobs: QuoteJob[]) => quoteJobs(client, cfg, tokenIn, paths, jobs, batchSize, exactOut);

  // For exact output, smaller is better and 0 means the path cannot fill.
  const better = (a: bigint, b: bigint) => (a === 0n ? false : b === 0n ? true : exactOut ? a < b : a > b);

  // 1. Full and tiny size on every path.
  const tiny = amount / 1000n > 0n ? amount / 1000n : 1n;
  const q1 = await quote(paths.flatMap((_, p) => [{ path: p, amount }, { path: p, amount: tiny }]));
  const full = paths.map((_, p) => q1[p * 2]);
  const small = paths.map((_, p) => q1[p * 2 + 1]);

  // Best output per unit of input at a tiny size: the "no impact" price.
  let refRate = 0;
  small.forEach((q) => {
    if (q === 0n) return;
    const rate = exactOut ? Number(tiny) / Number(q) : Number(q) / Number(tiny);
    if (rate > refRate) refRate = rate;
  });

  const ranked = paths
    .map((_, p) => p)
    .filter((p) => full[p] > 0n || small[p] > 0n)
    .sort((a, b) => (better(full[a], full[b]) ? -1 : better(full[b], full[a]) ? 1 : 0));
  if (ranked.length === 0) return null;

  const bestP = ranked[0];
  const bestSingle =
    full[bestP] > 0n
      ? exactOut
        ? { path: paths[bestP], amountIn: full[bestP], amountOut: amount }
        : { path: paths[bestP], amountIn: amount, amountOut: full[bestP] }
      : null;

  // 2. Every tenth on the shortlist. The 10/10 point is already known.
  const shortlist = ranked.slice(0, shortlistN);
  const q2 = await quote(
    shortlist.flatMap((p) => Array.from({ length: TENTHS - 1 }, (_, i) => ({ path: p, amount: tenth(amount, i + 1) }))),
  );
  const curve = new Map<number, bigint[]>();
  shortlist.forEach((p, s) => curve.set(p, [0n, ...q2.slice(s * (TENTHS - 1), (s + 1) * (TENTHS - 1)), full[p]]));

  // 3. Greedy by tenths over pool-disjoint paths.
  const alloc = new Map<number, number>();
  for (let step = 0; step < TENTHS; step++) {
    let pick = -1;
    let best = 0n;
    for (const p of shortlist) {
      const n = alloc.get(p) ?? 0;
      if (n === 0) {
        if (alloc.size >= maxLegs) continue;
        if (![...alloc.keys()].every((u) => disjoint(paths[u], paths[p]))) continue;
      }
      const pts = curve.get(p)!;
      if (n >= TENTHS || pts[n + 1] === 0n) continue;
      const d = pts[n + 1] - pts[n];
      if (pick === -1 || (exactOut ? d < best : d > best)) {
        pick = p;
        best = d;
      }
    }
    if (pick === -1) break;
    alloc.set(pick, (alloc.get(pick) ?? 0) + 1);
  }
  const allocated = [...alloc.values()].reduce((a, b) => a + b, 0);

  let legs: QuoteJob[];
  const single = () => [{ path: bestP, amount }];
  if (allocated === TENTHS && alloc.size > 1) {
    const entries = [...alloc.entries()].sort((a, b) => b[1] - a[1]);
    let assigned = 0n;
    legs = entries.map(([p, n], i) => {
      const a = i === entries.length - 1 ? amount - assigned : tenth(amount, n);
      assigned += a;
      return { path: p, amount: a };
    });
    const splitTotal = entries.reduce((s, [p, n]) => s + curve.get(p)![n], 0n);
    const singleTotal = full[bestP];
    if (bestSingle && !better(splitTotal, singleTotal)) legs = single();
  } else if (bestSingle) {
    legs = single();
  } else {
    return null;
  }

  // 4. Exact quotes for the final legs.
  let finalQ = await quote(legs);
  if (finalQ.some((q) => q === 0n)) {
    if (!bestSingle) return null;
    legs = single();
    finalQ = [full[bestP]];
  }
  const other = finalQ.reduce((a, b) => a + b, 0n);
  const amountIn = exactOut ? other : amount;
  const amountOut = exactOut ? amount : other;

  const planLegs: PlanLeg[] = legs.map((l, i) => ({
    path: paths[l.path],
    amountIn: exactOut ? finalQ[i] : l.amount,
    amountOut: exactOut ? l.amount : finalQ[i],
    share: Number((l.amount * 10000n) / amount) / 100,
  }));

  const efficiency = refRate > 0 ? Number(amountOut) / (refRate * Number(amountIn)) : 1;
  const impactBps = Math.max(0, Math.round((1 - efficiency) * 10000));
  let splitGainBps = 0;
  if (bestSingle) {
    const ratio = exactOut ? Number(bestSingle.amountIn) / Number(amountIn) : Number(amountOut) / Number(bestSingle.amountOut);
    splitGainBps = Math.max(0, Math.round((ratio - 1) * 10000));
  }

  return {
    tokenIn,
    tokenOut,
    exactOut,
    amountIn,
    amountOut,
    minAmountOut: exactOut ? amountOut : (amountOut * BigInt(10000 - slippageBps)) / 10000n,
    maxAmountIn: exactOut ? (amountIn * BigInt(10000 + slippageBps) + 9999n) / 10000n : amountIn,
    legs: planLegs,
    bestSingle,
    splitGainBps,
    impactBps,
    pathsConsidered: paths.length,
    quotedAt: Date.now(),
  };
}

const legArgs = (plan: Plan) =>
  plan.legs.map((l) => ({ amount: plan.exactOut ? l.amountOut : l.amountIn, hops: l.path.hops.map(hopArg) }));

const deadlineIn = (seconds: number) => BigInt(Math.floor(Date.now() / 1000) + seconds);

/** The router call for a plan, paid with an allowance (or ETH): `swap` or `swapExactOut`. */
export function swapCall(plan: Plan, recipient: Address, deadlineSeconds = 600) {
  const deadline = deadlineIn(deadlineSeconds);
  const value = plan.tokenIn === NATIVE ? plan.maxAmountIn : 0n;
  if (plan.exactOut) {
    return {
      functionName: "swapExactOut" as const,
      args: [plan.tokenIn, plan.tokenOut, legArgs(plan), plan.maxAmountIn, recipient, deadline] as const,
      value,
    };
  }
  return {
    functionName: "swap" as const,
    args: [plan.tokenIn, plan.tokenOut, legArgs(plan), plan.minAmountOut, recipient, deadline] as const,
    value,
  };
}

/** The `Trade` and legs for `swapWithPermit` / `swapWithPermit2`, and the amount the signature must cover. */
export function tradeArgs(plan: Plan, recipient: Address, deadlineSeconds = 600) {
  const trade = {
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    exactOut: plan.exactOut,
    amountLimit: plan.exactOut ? plan.maxAmountIn : plan.minAmountOut,
    recipient,
    deadline: deadlineIn(deadlineSeconds),
  };
  return { trade, legs: legArgs(plan), pull: plan.maxAmountIn };
}
