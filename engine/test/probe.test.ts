/** v4 probing finds exactly the hook-free pools that exist on the local chain, with no event history. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { probeV4Pools, NATIVE, type ChainConfig } from "../src/index.js";

const w = JSON.parse(readFileSync(new URL("../../contracts/local-world.json", import.meta.url), "utf8")) as Record<string, Address>;
const chain = defineChain({ id: 4663, name: "local", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [process.env.RPC_URL ?? "http://127.0.0.1:8545"] } } });
const client = createPublicClient({ chain, transport: http() }) as PublicClient;
const cfg: ChainConfig = { chainId: 4663, v3Factory: w.v3Factory, poolManager: w.poolManager, weth: w.weth, hubs: [w.usdg] };

async function main() {
  const found = await probeV4Pools(client, cfg, [w.nvda, w.tsla, w.aapl, w.meme], [w.usdg, NATIVE, w.weth]);
  const has = (a: Address, b: Address, fee: number) =>
    found.some((k) => [k.currency0, k.currency1].map((x) => x.toLowerCase()).sort().join() === [a, b].map((x) => x.toLowerCase()).sort().join() && k.fee === fee);
  assert.equal(found.length, 3, `expected 3 v4 pools, found ${found.length}`);
  assert.ok(has(w.usdg, w.nvda, 3000) && has(w.usdg, w.aapl, 500) && has(NATIVE, w.meme, 3000));
  console.log(`probe found ${found.length} v4 pools: ${found.map((k) => `${k.fee}/${k.tickSpacing}`).join(", ")}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
