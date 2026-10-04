"use client";

import type { Address } from "viem";
import { catalog } from "@/generated/vaults/catalog";
import { TokenDot } from "@/components/TokenDot";
import { stockToken } from "@/vaults/lib/brand";
import { useDeployment } from "@/vaults/lib/deployment";
import { VaultRow } from "./VaultCard";

type Ticker = keyof typeof catalog.equityTokens;
type Row = { ticker: string; name: string; vault?: Address };

/** Live Vaults first, then launch Vaults not yet deployed. */
export function useVaultRows(): { live: boolean; rows: Row[] } {
  const { deployment } = useDeployment();
  const live: Row[] = deployment ? Object.entries(deployment.vaults).map(([t, w]) => ({ ticker: t, name: w.name, vault: w.vault })) : [];
  const launch: Row[] = catalog.launchVaults
    .filter((t) => !live.some((r) => r.ticker === t))
    .map((t) => ({ ticker: t, name: catalog.equityTokens[t as Ticker].name }));
  return { live: live.length > 0, rows: [...live, ...launch] };
}

export function VaultTable({ rows, compact }: { rows: Row[]; compact?: boolean }) {
  return (
    <div className="markets-wrap">
      <table className="markets">
        <thead>
          <tr>
            <th>Vault</th>
            <th className="num">Held value</th>
            {!compact && <th className="num hide-m">Cap</th>}
            <th className="num hide-m">Yield rate</th>
            <th className="hide-m">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <VaultRow key={r.ticker} {...r} compact={compact} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VaultList() {
  const { rows } = useVaultRows();
  const listed = rows.map((r) => r.ticker);
  const upcoming = (Object.keys(catalog.equityTokens) as Ticker[]).filter((t) => !listed.includes(t));

  return (
    <>
      <VaultTable rows={rows} />
      {upcoming.length > 0 && (
        <div className="vx-next">
          <div>
            <span className="label">Coming next</span>
            <p className="small muted">Opened once the stock&apos;s pool has enough depth and tracks its Chainlink feed.</p>
          </div>
          <div className="vx-chips">
            {upcoming.map((t) => (
              <span key={t} className="vx-chip" title={catalog.equityTokens[t].name}>
                <TokenDot token={stockToken(t)} />
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
