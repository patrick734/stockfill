"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import { TokenDot } from "@/components/TokenDot";
import { catalog } from "@/generated/vaults/catalog";
import { useVaultStats, useYieldRate } from "@/vaults/hooks/useVault";
import { stockToken } from "@/vaults/lib/brand";
import { DASH, fmtRate, fmtUsdg } from "@/vaults/lib/format";
import { routes } from "@/vaults/lib/links";
import { Pill } from "./ui";

/** Share of the cap filled, in percent, or undefined when nothing is held yet. */
export function capFill(held: bigint | undefined, cap: bigint | undefined) {
  if (!held || !cap) return undefined;
  return Number((held * 10_000n) / cap) / 100;
}

export function VaultStatus({ vault, paused, priceFresh }: { vault?: Address; paused?: boolean; priceFresh?: boolean }) {
  if (!vault) return <Pill tone="muted">Launching soon</Pill>;
  if (paused) return <Pill tone="warn">Paused</Pill>;
  if (priceFresh === false) return <Pill tone="warn">Market closed</Pill>;
  return <Pill tone="ok">Open</Pill>;
}

/** One Vault as a row of the markets-style table: held value against its cap, trailing yield, status. */
export function VaultRow({ ticker, name, vault, compact }: { ticker: string; name: string; vault?: Address; compact?: boolean }) {
  const router = useRouter();
  const s = useVaultStats(vault);
  const y = useYieldRate(vault, s.heldValue, s.equityToken, s.oracle);
  const fill = capFill(s.heldValue, s.cap);
  const href = routes.vault(ticker);
  const capNote = !vault
    ? `$${catalog.heldValueCapUsdg.toLocaleString("en-US")} at launch`
    : !s.cap
      ? undefined
      : fill !== undefined && fill >= 0.5
        ? `${fill.toFixed(0)}% of ${fmtUsdg(s.cap, 0)}`
        : fmtUsdg(s.cap, 0);

  return (
    <tr onClick={() => router.push(href)}>
      <td>
        <div className="asset">
          <TokenDot token={stockToken(ticker, name)} />
          <Link href={href} className="vx-row-link" onClick={(e) => e.stopPropagation()}>
            <b>{ticker}</b>
          </Link>
          <span className="asset-name">{name} Vault</span>
        </div>
      </td>
      <td className="num">
        {vault ? (s.isLoading ? <span className="skeleton" /> : fmtUsdg(s.heldValue, 0)) : DASH}
        {vault && fill !== undefined && (
          <div className="vx-capbar" title={`${fill.toFixed(1)}% of cap`}>
            <div style={{ width: `${Math.min(fill, 100)}%` }} />
          </div>
        )}
      </td>
      {!compact && <td className="num hide-m vx-dim">{capNote ?? DASH}</td>}
      <td className="num hide-m">{vault && y.data ? fmtRate(y.data) : DASH}</td>
      <td className="hide-m">
        <VaultStatus vault={vault} paused={s.paused} priceFresh={s.priceFresh} />
      </td>
      <td className="num action">
        <span className="trade-pill">{vault ? "Deposit" : "View"}</span>
      </td>
    </tr>
  );
}
