import type { Address } from "viem";
import type { V4PoolKey } from "@stockfill/engine";

export type Token = { address: Address; symbol: string; name: string; decimals: number; kind: "base" | "stock"; logo?: string };

/** The chain's own base assets. Everything else comes from /data/tokens.json. */
export const BASE_TOKENS: Token[] = [
  { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", decimals: 18, kind: "base" },
  { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "Global Dollar", decimals: 6, kind: "base" },
  { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", name: "Wrapped Ether", decimals: 18, kind: "base" },
];

/**
 * Emergency fallback only: used if /data/tokens.json is missing or unreadable, so the site still
 * trades the biggest names. The real list is built from Robinhood's registry by `npm run tokens`
 * and refreshed daily by .github/workflows/tokens.yml.
 */
export const SEED_TOKENS: Token[] = [
  ...BASE_TOKENS,
  { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", name: "Apple", decimals: 18, kind: "stock" },
  { address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", symbol: "CRCL", name: "Circle", decimals: 18, kind: "stock" },
  { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", name: "NVIDIA", decimals: 18, kind: "stock" },
  { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY", name: "S&P 500 ETF", decimals: 18, kind: "stock" },
  { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA", name: "Tesla", decimals: 18, kind: "stock" },
];

export async function loadTokens(): Promise<{ tokens: Token[]; v4Pools: V4PoolKey[]; indexedAt?: string }> {
  try {
    const [t, p] = await Promise.all([
      fetch("/data/tokens.json").then((r) => (r.ok ? r.json() : null)),
      fetch("/data/v4pools.json").then((r) => (r.ok ? r.json() : null)),
    ]);
    if (t?.tokens?.length) {
      // Registry data can carry Robinhood's generic logo and a "• Robinhood Token" name suffix: drop both.
      const tokens = (t.tokens as Token[]).map((x) => ({
        ...x,
        name: x.name.replace(/\s*[•·|-]\s*Robinhood\s+Token\s*$/i, "").trim(),
        logo: undefined,
      }));
      return { tokens, v4Pools: p?.pools ?? [], indexedAt: t.updatedAt };
    }
  } catch {
    /* fall through to the seed list */
  }
  return { tokens: SEED_TOKENS, v4Pools: [] };
}
