"use client";

import { useAccount, useDisconnect } from "wagmi";
import { BRAND } from "@/lib/brand";
import { CHAIN_ID } from "@/lib/config";
import { short } from "@/lib/format";
import { useOpenWallet } from "./Wallet";

export function Header() {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const openWallet = useOpenWallet();
  return (
    <header className="top">
      <div className="wrap top-row">
        <a className="wordmark" href="/" aria-label={`${BRAND.name} home`}>
          <Mark />
          <span>{BRAND.name}</span>
        </a>
        <nav className="nav">
          <a href="/#swap">Swap</a>
          <a href="/#markets">Markets</a>
          <a href="/vaults/">Vaults</a>
          <a href="/borrow/">Borrow</a>
          <a href="/portfolio/">Portfolio</a>
          <a href="/#how">How it works</a>
          <a href="/#faq">FAQ</a>
        </nav>
        <div className="top-right">
          <span className={`net${isConnected && chainId !== CHAIN_ID ? " bad" : ""}`}>
            <i /> Robinhood Chain
          </span>
          {isConnected ? (
            <button className="btn ghost" onClick={() => disconnect()} title="Disconnect">
              {short(address!)}
            </button>
          ) : (
            <button className="btn" onClick={openWallet}>
              Connect
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/** Logo mark: four rising bars, the last one filled to the top. */
export function Mark({ size = 22 }: { size?: number }) {
  const bars = [7, 10, 13, 16];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="mark">
      {bars.map((h, i) => (
        <rect key={i} x={2 + i * 4} y={22 - h} width="2.4" height={h} rx="1.2" fill="currentColor" />
      ))}
      <rect className="hot" x="18" y="2" width="2.4" height="20" rx="1.2" />
    </svg>
  );
}
