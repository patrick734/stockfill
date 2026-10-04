"use client";

import { catalog } from "@/generated/vaults/catalog";
import { creditSymbol, vaultSymbol } from "@/vaults/lib/brand";
import { useDeployment } from "@/vaults/lib/deployment";
import { CreditLine } from "./CreditLine";
import { NotDeployed } from "./ui";

export function BorrowDeskList() {
  const { deployment } = useDeployment();
  const lines = deployment ? Object.entries(deployment.creditLines).filter(([t]) => deployment.vaults[t]) : [];
  if (!deployment || lines.length === 0) {
    const first = catalog.launchCreditLines as readonly string[];
    return (
      <NotDeployed what="Credit Lines">
        {first.length > 0 && (
          <p className="small muted">
            First at launch: {first.map((t) => `${t} (pledge ${vaultSymbol(t)}, lend for ${creditSymbol(t)})`).join(", ")}.
          </p>
        )}
      </NotDeployed>
    );
  }
  return (
    <div className="vx-stack vx-lines">
      {lines.map(([ticker, desk]) => (
        <CreditLine key={ticker} ticker={ticker} desk={desk} vault={deployment.vaults[ticker].vault} usdg={deployment.usdg} />
      ))}
    </div>
  );
}
