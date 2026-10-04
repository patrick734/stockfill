"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Token } from "@/lib/tokens";
import type { Markets } from "@/lib/useMarkets";
import { short, usd } from "@/lib/format";
import { TokenDot } from "./TokenDot";

const NATIVE = "0x0000000000000000000000000000000000000000";

export function TokenPicker({
  tokens,
  markets,
  exclude,
  onPick,
  onClose,
}: {
  tokens: Token[];
  markets: Markets;
  exclude?: string;
  onPick: (t: Token) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return tokens.filter(
      (t) => !s || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.address.toLowerCase() === s,
    );
  }, [q, tokens]);

  const quick = tokens.filter((t) => ["ETH", "USDG"].includes(t.symbol));
  const isOff = (t: Token) => t.address.toLowerCase() === exclude?.toLowerCase();

  const group = (kind: Token["kind"], title: string) => {
    const items = list.filter((t) => t.kind === kind);
    if (!items.length) return null;
    return (
      <div>
        <div className="label tp-title">{title}</div>
        {items.map((t) => (
          <button key={t.address} className="tp-item" disabled={isOff(t)} onClick={() => onPick(t)}>
            <TokenDot token={t} />
            <span className="tp-main">
              <b>{t.symbol}</b>
              <span>{t.name}</span>
            </span>
            <span className="tp-right">
              {markets.usd(t.address) !== undefined ? usd(markets.usd(t.address)) : ""}
              <span>{t.address === NATIVE ? "native" : short(t.address)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal tp" role="dialog" aria-modal="true" aria-label="Select a token" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Select a token</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <input
          ref={input}
          className="tp-search"
          placeholder="Search a stock, ticker or address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="tp-quick">
          {quick.map((t) => (
            <button key={t.address} disabled={isOff(t)} onClick={() => onPick(t)}>
              <TokenDot token={t} /> {t.symbol}
            </button>
          ))}
        </div>
        <div className="tp-list">
          {group("stock", "Stock Tokens")}
          {group("base", "Base assets")}
          {list.length === 0 && <p className="muted tp-empty">No official token matches “{q}”.</p>}
        </div>
        <p className="tp-foot muted">Only official Robinhood Stock Tokens are listed. Copycats with the same ticker are left out.</p>
      </div>
    </div>
  );
}
