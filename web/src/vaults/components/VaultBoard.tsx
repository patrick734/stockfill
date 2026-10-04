"use client";

import "@/vaults/vaults.css";
import Link from "next/link";
import { useBlockNumber } from "wagmi";
import { useDeployment } from "@/vaults/lib/deployment";
import { routes } from "@/vaults/lib/links";
import { useVaultRows, VaultTable } from "./VaultList";

/** A compact live board of the Vaults (held value, yield, status), for embedding outside the Vaults page. */
export function VaultBoard() {
  const { deployment, chainId } = useDeployment();
  const { live, rows } = useVaultRows();
  const { data: block } = useBlockNumber({ chainId, query: { enabled: Boolean(deployment), refetchInterval: 15_000 } });

  return (
    <div className="vx">
      <div className="vx-board-head">
        <span className="label">{live ? "Live Vaults" : "Launch Vaults"}</span>
        <span className="label">{block ? `block ${block.toLocaleString("en-US")}` : deployment ? "…" : "launching soon"}</span>
      </div>
      <VaultTable rows={rows} compact />
      <p className="small">
        <Link href={routes.vaults}>All Vaults →</Link>
      </p>
    </div>
  );
}
