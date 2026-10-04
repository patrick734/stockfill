import type { Address } from "viem";
import { BRAND } from "@/lib/brand";
import { catalog } from "@/generated/vaults/catalog";
import type { Token } from "@/lib/tokens";

/** "$FILL", from the site's brand file. */
export const FILL = `$${BRAND.token.symbol}`;

/** Vault shares are sf{TICKER}; Credit Line lender shares are cl{TICKER}. */
export const vaultSymbol = (ticker: string) => `sf${ticker}`;
export const creditSymbol = (ticker: string) => `cl${ticker}`;

type Ticker = keyof typeof catalog.equityTokens;

export const stockName = (ticker: string): string => catalog.equityTokens[ticker as Ticker]?.name ?? ticker;

/** A Token for the site's TokenDot badge (company logo, monogram fallback). */
export function stockToken(ticker: string, name?: string): Token {
  const meta = catalog.equityTokens[ticker as Ticker];
  return {
    address: (meta?.address ?? "0x0000000000000000000000000000000000000000") as Address,
    symbol: ticker,
    name: name ?? meta?.name ?? ticker,
    decimals: 18,
    kind: "stock",
  };
}
