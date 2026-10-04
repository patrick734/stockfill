"use client";

import { useEffect, useState } from "react";
import { probeV4Pools, NATIVE, type V4PoolKey } from "@stockfill/engine";
import { usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { BRAND } from "@/lib/brand";
import { CHAIN_ID, ENGINE, ROUTER } from "@/lib/config";
import { BASE_TOKENS, loadTokens, type Token } from "@/lib/tokens";
import { useMarkets } from "@/lib/useMarkets";
import { Header } from "@/components/Header";
import { Ticker } from "@/components/Ticker";
import { SwapCard, type Preset } from "@/components/SwapCard";
import { CopyCA } from "@/components/CopyCA";
import { MarketsTable } from "@/components/MarketsTable";
import { Contracts, FAQ, Footer, HowItFills, TokenSection } from "@/components/Sections";

export default function Home() {
  // ETH, USDG and WETH first; the Stock Token list arrives from tokens.json a moment later.
  const [tokens, setTokens] = useState<Token[]>(BASE_TOKENS);
  const [listReady, setListReady] = useState(false);
  const [v4Pools, setV4Pools] = useState<V4PoolKey[]>([]);
  const [preset, setPreset] = useState<Preset | undefined>();
  const markets = useMarkets(tokens, v4Pools);

  const client = usePublicClient({ chainId: CHAIN_ID }) as PublicClient | undefined;
  useEffect(() => {
    loadTokens().then(async (d) => {
      setTokens(d.tokens);
      setV4Pools(d.v4Pools);
      setListReady(true);
      // Without an indexed v4 list, probe the standard hook-free pools of the listed stocks.
      if (d.v4Pools.length === 0 && client) {
        try {
          const stocks = d.tokens.filter((t) => t.kind === "stock").map((t) => t.address);
          const found = await probeV4Pools(client, ENGINE, stocks, [ENGINE.hubs[0], NATIVE, ENGINE.weth]);
          if (found.length) setV4Pools(found);
        } catch {
          /* v3 routes still work */
        }
      }
    });
  }, [client]);

  const trade = (t: Token) => {
    setPreset((p) => ({ out: t, nonce: (p?.nonce ?? 0) + 1 }));
    document.getElementById("swap")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const stocks = tokens.filter((t) => t.kind === "stock").length;
  const pools = [...markets.rows.values()].reduce((s, r) => s + r.venues.v3 + r.venues.v4, 0);

  return (
    <>
      <Ticker tokens={tokens} markets={markets} onPick={trade} />
      <Header />
      <main>
        <section className="hero wrap">
          <div className="hero-copy">
            <div className="pills">
              <span className="pill">
                <i className="live-dot" /> Live on Robinhood Chain
              </span>
              <span className="pill">0% router fee · no owner</span>
            </div>
            <h1>
              Stocks on-chain, <em>filled at the best price.</em>
            </h1>
            <p className="lede">
              {BRAND.name} reads every pool that trades your pair, simulates each path against live liquidity, and splits
              your trade across the ones that pay most. Sell an exact amount or buy one, often with a single signature
              instead of an approval. One transaction. No router fee.
            </p>
            <div className="figures">
              <div>
                <b>{listReady && stocks > 0 ? stocks : "—"}</b>
                <span>Stock Tokens</span>
              </div>
              <div>
                <b>{pools || "—"}</b>
                <span>Live pools</span>
              </div>
              <div>
                <b>0%</b>
                <span>Router fee</span>
              </div>
            </div>
            <CopyCA />
            {!ROUTER && (
              <p className="notice small">
                <i />
                <span>Quotes are live against mainnet pools. Swapping opens when the router is deployed.</span>
              </p>
            )}
          </div>
          <SwapCard tokens={tokens} v4Pools={v4Pools} markets={markets} preset={preset} />
        </section>
        <MarketsTable tokens={tokens} markets={markets} onTrade={trade} />
        <HowItFills />
        <Contracts />
        <TokenSection />
        <FAQ />
      </main>
      <Footer />
    </>
  );
}
