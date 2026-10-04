import type { Address } from "viem";
import type { ChainConfig } from "./types.js";

/** Robinhood Chain mainnet. The router and quoter addresses come from the deployment (robinhoodConfig arguments). */
export const ROBINHOOD = {
  chainId: 4663,
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  /** A known official Robinhood Stock Token, used to recognise the others by their beacon. */
  referenceStock: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address | number>;

export function robinhoodConfig(router?: Address, quoter?: Address, withMulticall = true): ChainConfig {
  return {
    chainId: ROBINHOOD.chainId,
    v3Factory: ROBINHOOD.v3Factory,
    poolManager: ROBINHOOD.poolManager,
    weth: ROBINHOOD.weth,
    hubs: [ROBINHOOD.usdg],
    router,
    quoter,
    multicall3: withMulticall ? ROBINHOOD.multicall3 : undefined,
  };
}
