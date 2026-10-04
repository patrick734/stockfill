"use client";

import { useState } from "react";
import type { Token } from "@/lib/tokens";
import { logoSources } from "@/lib/logos";

/** Ether diamond, drawn locally. */
function EthMark() {
  return (
    <span className="tk-dot tk-eth" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="60%" height="60%">
        <path d="M12 2 5.5 12.3 12 16l6.5-3.7L12 2Z" fill="currentColor" opacity=".9" />
        <path d="M12 17.3 5.5 13.6 12 22l6.5-8.4-6.5 3.7Z" fill="currentColor" opacity=".65" />
      </svg>
    </span>
  );
}

/** Token badge: the company logo for Stock Tokens, built-in marks for ETH and USDG, a monogram as last resort. */
export function TokenDot({ token }: { token?: Token }) {
  const [attempt, setAttempt] = useState(0);
  if (!token) return <span className="tk-dot">?</span>;
  if (token.symbol === "ETH" || token.symbol === "WETH") return <EthMark />;
  if (token.symbol === "USDG") return <span className="tk-dot tk-usd" aria-hidden="true">$</span>;

  const sources = token.kind === "stock" ? [...(token.logo ? [token.logo] : []), ...logoSources(token.symbol)] : [];
  if (attempt < sources.length) {
    return (
      <img
        key={sources[attempt]}
        className="tk-dot tk-img"
        src={sources[attempt]}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setAttempt((a) => a + 1)}
      />
    );
  }
  return (
    <span className={`tk-dot${token.kind === "stock" ? " stock" : ""}`} aria-hidden="true">
      {token.symbol.slice(0, 3)}
    </span>
  );
}
