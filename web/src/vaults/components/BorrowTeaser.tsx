"use client";

import Link from "next/link";
import { useReadContracts } from "wagmi";
import { borrowDeskAbi } from "@/generated/vaults/abis";
import { useDeployment } from "@/vaults/lib/deployment";
import { DASH, fmtBps, fmtUsdg, fmtWadPct, nonZero } from "@/vaults/lib/format";
import { routes } from "@/vaults/lib/links";
import { SectionHead, Stat, Stats } from "./ui";

export function BorrowTeaser() {
  const { deployment, chainId } = useDeployment();
  const [ticker, desk] = deployment ? (Object.entries(deployment.creditLines)[0] ?? []) : [];
  const d = { address: desk, abi: borrowDeskAbi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(desk) },
    contracts: [
      { ...d, functionName: "borrowRatePerYear" },
      { ...d, functionName: "supplyRatePerYear" },
      { ...d, functionName: "risk" },
      { ...d, functionName: "borrowCap" },
      { ...d, functionName: "totalDebt" },
      { ...d, functionName: "cash" },
    ],
  });
  const g = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const risk = g<readonly number[]>(2);
  const cap = g<bigint>(3);
  const debt = g<bigint>(4);
  const cash = g<bigint>(5);
  const underCap = cap !== undefined && debt !== undefined ? (cap > debt ? cap - debt : 0n) : undefined;
  const room = underCap !== undefined && cash !== undefined ? (underCap < cash ? underCap : cash) : undefined;

  return (
    <section className="section">
      <SectionHead label="Borrow" title={<>Borrow against <em>your shares.</em></>}>
        Pledge Vault shares on a Credit Line and draw USDG. Collateral is valued at the Chainlink price, never the pool price.
      </SectionHead>
      {desk ? (
        <Stats>
          <Stat label={`${ticker} borrow rate`} value={fmtWadPct(g<bigint>(0))} hint="variable, per year" />
          <Stat label="Max LTV" value={risk ? fmtBps(risk[0]) : DASH} hint={risk && risk[1] ? `liquidation at ${fmtBps(risk[1])}` : undefined} />
          <Stat label="Available to borrow" value={fmtUsdg(room, 0)} hint={nonZero(cap) ? `of ${fmtUsdg(cap, 0)} cap` : undefined} />
          <Stat label="Lend rate" value={fmtWadPct(g<bigint>(1))} hint="variable, per year" />
        </Stats>
      ) : null}
      <div className="vx-cta-row">
        <Link href={routes.borrow} className="btn">
          {desk ? "Open Credit Lines" : "Credit Lines: launching soon"}
        </Link>
      </div>
    </section>
  );
}
