/** Checks the explorer log source against plain eth_getLogs on the local chain, with paging. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Abi, Address } from "viem";
import { fetchEventLogs } from "../src/logs.js";
import { poolManagerAbi, v3FactoryAbi } from "../src/abi.js";

const w = JSON.parse(readFileSync(new URL("../../contracts/local-world.json", import.meta.url), "utf8")) as Record<string, Address>;
const explorer = { api: process.env.MOCK_API ?? "http://127.0.0.1:5090", rpc: process.env.RPC_URL ?? "http://127.0.0.1:8545", pageSize: 2 };
const rpc = { api: "rpc", rpc: process.env.RPC_URL ?? "http://127.0.0.1:8545" };

async function main() {
  const all = { from: 0n, to: 10_000n };
  const a = await fetchEventLogs<{ token0: Address; token1: Address; pool: Address }>(explorer, w.v3Factory, v3FactoryAbi as Abi, "PoolCreated", {}, all.from, all.to);
  const b = await fetchEventLogs<{ token0: Address; token1: Address; pool: Address }>(rpc, w.v3Factory, v3FactoryAbi as Abi, "PoolCreated", {}, all.from, all.to);
  assert.equal(a.length, b.length, "explorer paging returns every log");
  assert.deepEqual(new Set(a.map((x) => x.pool)), new Set(b.map((x) => x.pool)));
  console.log(`PoolCreated: ${a.length} via explorer (pages of 2) = ${b.length} via rpc`);

  const usdgSide = await fetchEventLogs<{ token0: Address; token1: Address }>(explorer, w.v3Factory, v3FactoryAbi as Abi, "PoolCreated", { token0: w.usdg }, all.from, all.to);
  const usdgRpc = await fetchEventLogs<{ token0: Address; token1: Address }>(rpc, w.v3Factory, v3FactoryAbi as Abi, "PoolCreated", { token0: w.usdg }, all.from, all.to);
  assert.equal(usdgSide.length, usdgRpc.length, "topic filter works");
  assert.ok(usdgSide.every((x) => x.token0.toLowerCase() === w.usdg.toLowerCase()));
  const usdg1 = await fetchEventLogs<{ token0: Address; token1: Address }>(explorer, w.v3Factory, v3FactoryAbi as Abi, "PoolCreated", { token1: w.usdg }, all.from, all.to);
  assert.equal(usdgSide.length + usdg1.length, 5, "five v3 pools pair with USDG");
  assert.ok(usdg1.every((x) => x.token1.toLowerCase() === w.usdg.toLowerCase()));
  console.log(`PoolCreated with USDG: ${usdgSide.length} as token0 + ${usdg1.length} as token1`);

  const init = await fetchEventLogs<{ currency0: Address; fee: number; tickSpacing: number }>(explorer, w.poolManager, poolManagerAbi as Abi, "Initialize", {}, all.from, all.to);
  assert.equal(init.length, 3, "all three v4 pools");
  console.log(`Initialize: ${init.length} (fees ${init.map((x) => x.fee).join(", ")})`);
  console.log("log sources agree");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
