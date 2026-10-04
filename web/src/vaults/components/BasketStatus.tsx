"use client";

import { useReadContracts } from "wagmi";
import { basketProgramAbi } from "@/generated/vaults/abis";
import { explorerAddress } from "@/vaults/lib/chains";
import { useDeployment } from "@/vaults/lib/deployment";
import { DASH, fmtBps, fmtUsdg } from "@/vaults/lib/format";
import { Pill, SectionHead, Stat, Stats } from "./ui";

export function BasketStatus() {
  const { deployment, chainId } = useDeployment();
  const b = { address: deployment?.basketProgram, abi: basketProgramAbi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [
      { ...b, functionName: "totalAssets" },
      { ...b, functionName: "heldValueCap" },
      { ...b, functionName: "vaults" },
      { ...b, functionName: "maxAllocationBps" },
    ],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const cap = r<bigint>(1);
  const vaults = r<readonly unknown[]>(2);
  const open = cap !== undefined && cap > 0n;

  return (
    <section className="section">
      <SectionHead label="Basket Program" title={<>One deposit, <em>several Vaults.</em></>}>
        A keeper spreads one deposit across several Vaults, capped at a maximum share per Vault. Exit in USDG from the idle
        balance, or in kind as USDG plus Vault shares.
      </SectionHead>
      <div className="vx-card">
        <div className="vx-card-head">
          <h3>Basket Program</h3>
          {!deployment ? <Pill tone="muted">Launching soon</Pill> : open ? <Pill tone="ok">Open</Pill> : <Pill tone="muted">Closed</Pill>}
        </div>
        {deployment ? (
          <>
            <Stats>
              <Stat label="Held value" value={fmtUsdg(r<bigint>(0), 0)} />
              <Stat label="Cap" value={open ? fmtUsdg(cap, 0) : cap === undefined ? "…" : "Closed"} />
              <Stat label="Vaults" value={vaults ? (vaults.length > 0 ? String(vaults.length) : DASH) : "…"} />
              <Stat label="Max per Vault" value={fmtBps(r<number>(3))} />
            </Stats>
            <p className="small vx-links">
              <a href={explorerAddress(deployment.basketProgram)} target="_blank" rel="noopener">
                Basket contract ↗
              </a>
            </p>
          </>
        ) : (
          <p className="small muted">Opens with the vault contracts. Its live held value and cap appear here at launch.</p>
        )}
      </div>
    </section>
  );
}
