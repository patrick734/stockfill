"use client";

import type { Markets } from "@/lib/useMarkets";
import type { Token } from "@/lib/tokens";
import { usd } from "@/lib/format";

/** Scrolling tape of live prices. Clicking a symbol loads it into the swap. */
export function Ticker({ tokens, markets, onPick }: { tokens: Token[]; markets: Markets; onPick: (t: Token) => void }) {
  const stocks = tokens.filter((t) => t.kind === "stock");
  const eth = tokens.find((t) => t.symbol === "WETH");
  const items = [...stocks, ...(eth ? [eth] : [])];
  if (items.length === 0) return <div className="ticker" />;
  const row = (key: string) =>
    items.map((t) => {
      const r = markets.rows.get(t.address.toLowerCase());
      const venues = r ? r.venues.v3 + r.venues.v4 : undefined;
      return (
        <button key={key + t.address} className="ticker-item" onClick={() => onPick(t)} tabIndex={key === "b" ? -1 : 0}>
          <b>{t.symbol === "WETH" ? "ETH" : t.symbol}</b>
          <span>{r?.price ? usd(r.price) : markets.loading ? "…" : "—"}</span>
          {!!venues && <em>{venues} {venues === 1 ? "pool" : "pools"}</em>}
        </button>
      );
    });
  return (
    <div className="ticker" aria-label="Live prices">
      <div className="ticker-track">
        {row("a")}
        <span aria-hidden="true" style={{ display: "contents" }}>
          {row("b")}
        </span>
      </div>
    </div>
  );
}
