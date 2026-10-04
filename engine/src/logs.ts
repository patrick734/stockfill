import { createPublicClient, decodeEventLog, encodeEventTopics, http, type Abi, type Address } from "viem";

// Event history for the indexer. Free RPC plans cap eth_getLogs at a few blocks, so the default
// source is the Blockscout explorer API (whole-chain queries, 1,000 logs per page).

type RawLog = { address: string; topics: (string | null)[]; data: string; blockNumber: bigint; key: string };

/** Blockscout's etherscan-style getLogs: up to 1,000 logs per call, paged by block number. */
async function logsFromExplorer(
  api: string,
  apiKey: string | undefined,
  rpcUrl: string,
  address: Address,
  topics: (string | null)[],
  from: bigint,
  to: bigint,
  pageSize: number,
): Promise<RawLog[]> {
  const out = new Map<string, RawLog>();
  let start = from;
  for (let page = 0; page < 10_000; page++) {
    const q = new URLSearchParams({ module: "logs", action: "getLogs", address, fromBlock: start.toString(), toBlock: to.toString() });
    topics.forEach((t, i) => {
      if (t) q.set(`topic${i}`, t);
    });
    const present = topics.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
    for (let k = 1; k < present.length; k++) q.set(`topic${present[0]}_${present[k]}_opr`, "and");
    if (apiKey) q.set("apikey", apiKey);

    let body: { status?: string; message?: string; result?: unknown } | undefined;
    for (let attempt = 0; attempt < 4 && !body; attempt++) {
      try {
        const r = await fetch(`${api}${api.includes("?") ? "&" : "?"}${q}`, { headers: { accept: "application/json" } });
        if (r.status === 429 || r.status >= 500) throw new Error(`explorer HTTP ${r.status}`);
        const text = await r.text();
        if (!text.trimStart().startsWith("{")) {
          throw new Error(`explorer returned a web page, not JSON (HTTP ${r.status}). Check the explorer API URL and key.`);
        }
        body = JSON.parse(text);
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    const rows = Array.isArray(body?.result) ? (body!.result as Record<string, unknown>[]) : [];
    if (!Array.isArray(body?.result) && body?.status !== "0") throw new Error(`explorer said: ${JSON.stringify(body).slice(0, 300)}`);

    let maxBlock = start;
    for (const r of rows) {
      const blockNumber = BigInt(r.blockNumber as string);
      const key = `${r.transactionHash}:${r.logIndex}`;
      out.set(key, { address: r.address as string, topics: r.topics as (string | null)[], data: r.data as string, blockNumber, key });
      if (blockNumber > maxBlock) maxBlock = blockNumber;
    }
    if (rows.length < pageSize) break;
    if (maxBlock > start) {
      // Next page starts at the last block seen (inclusive; duplicates are dropped by key).
      start = maxBlock;
    } else {
      // A whole page inside one block: read that block straight from the RPC, then move on.
      for (const l of await logsFromRpc(rpcUrl, address, topics, start, start)) out.set(l.key, l);
      start = start + 1n;
    }
    if (start > to) break;
  }
  return [...out.values()];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e: unknown) => {
  const x = e as { status?: number; code?: number; details?: string; message?: string; cause?: { code?: number } };
  return x?.status === 429 || x?.code === 429 || x?.cause?.code === 429 || /too many requests|rate limit/i.test(`${x?.details} ${x?.message}`);
};

/**
 * Plain eth_getLogs, halving the range when the RPC says the range or result is too big.
 * Rate limits are not a "too big" signal: those wait and retry the same range.
 */
async function logsFromRpc(url: string, address: Address, topics: (string | null)[], from: bigint, to: bigint): Promise<RawLog[]> {
  const rpc = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  const go = async (a: bigint, b: bigint, attempt = 0): Promise<RawLog[]> => {
    try {
      const logs = await rpc.request({
        method: "eth_getLogs",
        params: [{ address, topics: topics as `0x${string}`[], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
      });
      return (logs as { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[]).map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: BigInt(l.blockNumber),
        key: `${l.transactionHash}:${l.logIndex}`,
      }));
    } catch (e) {
      if (isRateLimit(e)) {
        if (attempt >= 8) throw e;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        return go(a, b, attempt + 1);
      }
      if (b - a < 10n) throw e;
      const mid = a + (b - a) / 2n;
      return [...(await go(a, mid)), ...(await go(mid + 1n, b))];
    }
  };
  return go(from, to);
}

export type LogSource = {
  /** Blockscout (etherscan-style) API base, or "rpc" to use plain eth_getLogs on `rpc`. */
  api: string;
  rpc: string;
  /** Results per explorer page (Blockscout returns at most 1,000). */
  pageSize?: number;
  /** Explorer API key (Blockscout PRO API, free tier works). */
  apiKey?: string;
};

/** All logs of one event, decoded. */
export async function fetchEventLogs<T>(
  src: LogSource,
  address: Address,
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  from: bigint,
  to: bigint,
): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topics = encodeEventTopics({ abi, eventName, args } as any) as (string | null)[];
  const raw =
    src.api === "rpc"
      ? await logsFromRpc(src.rpc, address, topics, from, to)
      : await logsFromExplorer(src.api, src.apiKey, src.rpc, address, topics, from, to, src.pageSize ?? 1000);
  return raw
    .filter((l) => l.address.toLowerCase() === address.toLowerCase())
    .map((l) => {
      const t = l.topics.filter((x): x is string => !!x) as [`0x${string}`, ...`0x${string}`[]];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (decodeEventLog({ abi, data: l.data as `0x${string}`, topics: t } as any) as unknown as { args: T }).args;
    });
}

