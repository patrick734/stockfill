import { createConfig, http, injected } from "wagmi";
import { defineChain, type Address } from "viem";
import { robinhoodConfig, ROBINHOOD, type ChainConfig } from "@stockfill/engine";

export const CHAIN_ID = 4663;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

import deployed from "@/generated/router.json";

const addr = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);
const gen = deployed as Partial<Record<"router" | "quoter" | "block", string | number>>;
/** RouterStockfill and QuoterStockfill, written to src/generated/router.json by launch.sh. The env vars only
 *  apply before a deployment exists (local testing); without a router the app quotes but cannot swap. */
export const ROUTER = addr(gen.router as string) ?? addr(process.env.NEXT_PUBLIC_ROUTER);
export const QUOTER = addr(gen.quoter as string) ?? addr(process.env.NEXT_PUBLIC_QUOTER);

/** Mainnet addresses by default; every one can be overridden (used for local testing against anvil). */
const base = robinhoodConfig(ROUTER, QUOTER, process.env.NEXT_PUBLIC_NO_MULTICALL !== "1");
const usdg = addr(process.env.NEXT_PUBLIC_USDG);
export const ENGINE: ChainConfig = {
  ...base,
  v3Factory: addr(process.env.NEXT_PUBLIC_V3_FACTORY) ?? base.v3Factory,
  poolManager: addr(process.env.NEXT_PUBLIC_POOL_MANAGER) ?? base.poolManager,
  weth: addr(process.env.NEXT_PUBLIC_WETH) ?? base.weth,
  hubs: usdg ? [usdg] : base.hubs,
};
export { ROBINHOOD };

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  contracts: process.env.NEXT_PUBLIC_NO_MULTICALL === "1" ? undefined : { multicall3: { address: ROBINHOOD.multicall3 } },
});

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: { [robinhoodChain.id]: http(RPC_URL, { batch: true }) },
  // The engine batches its own reads (Multicall3 when present, plain calls otherwise).
  batch: { multicall: false },
  // Static export: hydrate with the server markup first, then reconnect the wallet (avoids hydration mismatches).
  ssr: true,
});

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
