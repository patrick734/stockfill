"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWatchAsset } from "wagmi";
import { buyBurnAbi, fillTokenAbi } from "@/generated/vaults/abis";
import { BRAND } from "@/lib/brand";
import { explorerAddress } from "@/vaults/lib/chains";
import { useDeployment } from "@/vaults/lib/deployment";
import { useBurnQueue, useFillToken } from "@/vaults/hooks/useProtocol";
import { FILL } from "@/vaults/lib/brand";
import { fmtAmount, fmtUsdg, nonZero, shortAddress } from "@/vaults/lib/format";
import { tradeUrl } from "@/vaults/lib/links";
import { KV, Pill } from "./ui";

/** $FILL: supply, how much the buy-back has burned, what is waiting to be spent, and the official address. */
export function FillTokenDetails() {
  const { deployment, chainId } = useDeployment();
  const { isConnected } = useAccount();
  const { watchAsset, isPending } = useWatchAsset();
  const [copied, setCopied] = useState(false);
  const queue = useBurnQueue();
  const { token, pending } = useFillToken();
  const t = { address: token, abi: fillTokenAbi, chainId } as const;
  const { data, isError } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(token) },
    contracts: [
      { ...t, functionName: "name" },
      { ...t, functionName: "symbol" },
      { ...t, functionName: "decimals" },
      { ...t, functionName: "totalSupply" },
    ],
  });
  const retiredQ = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [{ address: deployment?.buyBurn, abi: buyBurnAbi, chainId, functionName: "totalRetired" }],
  });
  const unreachable = isError || (data !== undefined && data.every((x) => x.status !== "success"));
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const name = r<string>(0);
  const symbol = r<string>(1);
  const decimals = r<number>(2);
  const supply = r<bigint>(3);
  const retired = retiredQ.data?.[0]?.status === "success" ? (retiredQ.data[0].result as bigint) : undefined;
  const d = decimals ?? 18;
  const original = supply !== undefined && retired !== undefined ? supply + retired : undefined;
  const retiredPct = (() => {
    if (!nonZero(original) || !nonZero(retired)) return undefined;
    const pct = Number((retired * 1_000_000n) / original) / 10_000;
    return pct >= 0.01 ? `${pct.toFixed(2)}%` : undefined;
  })();
  const waiting = nonZero(queue.usdg) ? queue.usdg : undefined;
  const title = symbol ? `$${symbol}` : FILL;

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the address is still shown and linked */
    }
  }

  return (
    <div className="vx-token">
      <div className="vx-card-head">
        <span className="label">The {BRAND.name} token</span>
        {pending || !token ? <Pill tone="burn">Launching soon</Pill> : <Pill tone="burn">Buy-back and burn</Pill>}
      </div>
      <h3>{title}</h3>
      <p>
        The protocol&apos;s share of Vault trading fees (30%, and never more) buys {FILL} on the market and burns it. The
        burn contract has no withdrawal function, so fees only ever leave it as burned {FILL}.
      </p>

      {(pending || !token) && (
        <>
          <p>
            {FILL} launches on Pons. {deployment ? "Protocol fees earned before then wait in the burn contract and are spent on it once it is live." : "The official address appears here first."}
          </p>
          {deployment && (
            <div className="vx-kvs">
              <KV k="Waiting to be spent">{waiting ? fmtUsdg(waiting) : queue.usdg === undefined ? "…" : "Nothing yet"}</KV>
            </div>
          )}
          <div className="vx-cta-row">
            <a className="vx-token-btn" href={tradeUrl()} target="_blank" rel="noopener">
              Pons launchpad ↗
            </a>
          </div>
        </>
      )}

      {token && !pending && (
        <>
          {unreachable && <p className="err small">Couldn&apos;t read the token from the network.</p>}
          <div className="vx-kvs">
            {nonZero(supply) && <KV k="Total supply">{fmtAmount(supply, d, 0)}</KV>}
            {nonZero(retired) && (
              <KV k="Burned so far">
                {fmtAmount(retired, d, 0)}
                {retiredPct ? ` (${retiredPct})` : ""}
              </KV>
            )}
            {deployment && <KV k="Waiting to be spent">{waiting ? fmtUsdg(waiting) : queue.usdg === undefined ? "…" : "Nothing yet"}</KV>}
            {name && <KV k="Name">{name}</KV>}
            <KV k="Contract">
              <a href={explorerAddress(token)} target="_blank" rel="noopener">
                {shortAddress(token)} ↗
              </a>
            </KV>
          </div>
          <div className="vx-cta-row">
            <a className="vx-token-btn" href={tradeUrl(token)} target="_blank" rel="noopener">
              Trade on Pons ↗
            </a>
            <button className="vx-token-btn ghost" onClick={copy}>
              {copied ? "Copied" : "Copy address"}
            </button>
            {isConnected && (
              <button
                className="vx-token-btn ghost"
                disabled={!symbol || isPending}
                onClick={() => watchAsset({ type: "ERC20", options: { address: token, symbol: symbol!, decimals: d } })}
              >
                Add {title} to wallet
              </button>
            )}
          </div>
          <p className="small vx-token-note">Copycat tokens appear within minutes of any launch. Only this address is ours.</p>
        </>
      )}
    </div>
  );
}
