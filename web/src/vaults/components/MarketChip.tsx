"use client";

import { useEffect, useState } from "react";
import { marketState, type MarketState } from "@/vaults/lib/market";

/** Live NYSE session chip. Chainlink equity prices pause outside the session, so deposits pause with them. */
export function MarketChip() {
  const [state, setState] = useState<MarketState | null>(null);
  useEffect(() => {
    const tick = () => setState(marketState());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  if (!state)
    return (
      <span className="pill" aria-hidden>
        <i className="vx-dot" /> NYSE
      </span>
    );
  return (
    <span className="pill" title="Chainlink stock prices update during the NYSE session; Vault deposits follow them.">
      <i className={state.open ? "live-dot" : "vx-dot"} /> {state.label}
    </span>
  );
}
