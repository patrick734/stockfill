"use client";

import { useState } from "react";
import type { MarketRow } from "@stockfill/engine";
import type { Markets } from "@/lib/useMarkets";
import type { Token } from "@/lib/tokens";
import { usd } from "@/lib/format";
import { TokenDot } from "./TokenDot";

const NATIVE = "0x0000000000000000000000000000000000000000";
const SHOW = 12;

/** Uniswap fee units (100 = 0.01%) as a short percent: 0.01%, 0.05%, 0.3%. */
function feePct(fee?: number): string {
  if (fee === undefined) return "—";
  const pct = fee / 10000;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;
}

function venues(r?: MarketRow): string {
  if (!r) return "—";
  const v = [r.venues.v4 ? "v4" : "", r.venues.v3 ? "v3" : ""].filter(Boolean);
  return v.length ? v.join(" + ") : "—";
}

/** Every asset the router can reach: live price, how many pools hold it, where, and the cheapest fee tier. */
export function MarketsTable({ tokens, markets, onTrade }: { tokens: Token[]; markets: Markets; onTrade: (t: Token) => void }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);

  const weth = tokens.find((t) => t.symbol === "WETH");
  const rowOf = (t: Token): MarketRow | undefined =>
    markets.rows.get((t.address === NATIVE && weth ? weth.address : t.address).toLowerCase());

  // ETH (shown as one asset with WETH), USDG, then every Stock Token.
  const assets = tokens.filter((t) => t.kind === "stock" || t.symbol === "ETH" || t.symbol === "USDG");
  const needle = q.trim().toLowerCase();
  const matching = assets.filter((t) => !needle || t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle));
  const sorted = [...matching].sort((a, b) => (rowOf(b)?.pools ?? 0) - (rowOf(a)?.pools ?? 0) || a.symbol.localeCompare(b.symbol));
  const shown = all || needle ? sorted : sorted.slice(0, SHOW);
  const stockCount = tokens.filter((t) => t.kind === "stock").length;

  return (
    <section id="markets" className="section wrap">
      <div className="section-head">
        <span className="label">Markets</span>
        <h2>
          Every stock, <em>priced by the pools.</em>
        </h2>
        <p>Prices come from real quotes against live liquidity, not a feed. Pools, venues and fees are read straight from Uniswap.</p>
      </div>
      <div className="markets-tools">
        <input className="tp-search" placeholder={`Search ${stockCount} stocks`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="markets-wrap">
        <table className="markets">
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">
                Price {markets.loading ? null : <i className="live-dot" title="Live" />}
              </th>
              <th className="num">Pools</th>
              <th className="num hide-m">Venues</th>
              <th className="num hide-m">Cheapest fee</th>
              <th className="hide-m" />
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              const r = rowOf(t);
              const loading = !r && markets.loading;
              const tradable = t.symbol !== "USDG";
              return (
                <tr key={t.address} onClick={tradable ? () => onTrade(t) : undefined} className={tradable ? "" : "static"}>
                  <td>
                    <div className="asset">
                      <TokenDot token={t} />
                      <b>{t.symbol}</b>
                      <span className="asset-name">{t.name}</span>
                    </div>
                  </td>
                  <td className="num">{loading ? <span className="skeleton" /> : usd(r?.price)}</td>
                  <td className="num">{loading ? <span className="skeleton" /> : (r?.pools ? r.pools : "—")}</td>
                  <td className="num hide-m">{loading ? <span className="skeleton" /> : venues(r)}</td>
                  <td className="num hide-m">{loading ? <span className="skeleton" /> : feePct(r?.minFee)}</td>
                  <td className="num hide-m action">{tradable && <span className="trade-pill">Trade</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!all && !needle && sorted.length > SHOW && (
        <button className="chip show-all" onClick={() => setAll(true)}>
          Show all {sorted.length} assets
        </button>
      )}
      <div className="markets-foot small muted">
        <span>
          {stockCount > 0 ? `${stockCount} official Stock Tokens` : "Loading Stock Tokens…"}
        </span>
        <span className="mono">{markets.updatedAt ? `updated ${new Date(markets.updatedAt).toLocaleTimeString()}` : "loading…"}</span>
      </div>
    </section>
  );
}
