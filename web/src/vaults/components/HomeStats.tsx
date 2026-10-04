"use client";

import { useReadContracts } from "wagmi";
import { catalog } from "@/generated/vaults/catalog";
import { buyBurnAbi, vaultAbi } from "@/generated/vaults/abis";
import { useBurnQueue } from "@/vaults/hooks/useProtocol";
import { FILL } from "@/vaults/lib/brand";
import { useDeployment } from "@/vaults/lib/deployment";
import { fmtAmount, fmtUsdg, nonZero } from "@/vaults/lib/format";
import { Stat, Stats } from "./ui";

/** Headline figures for the Vaults page. Live numbers once deployed; nothing ever reads zero. */
export function HomeStats() {
  const { deployment, chainId } = useDeployment();
  const vaults = deployment ? Object.values(deployment.vaults) : [];
  const retiredQ = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [{ address: deployment?.buyBurn, abi: buyBurnAbi, chainId, functionName: "totalRetired" }],
  });
  const held = useReadContracts({
    allowFailure: true,
    query: { enabled: vaults.length > 0 },
    contracts: vaults.map((w) => ({ address: w.vault, abi: vaultAbi, chainId, functionName: "totalAssets" }) as const),
  });
  const queue = useBurnQueue();
  const totalHeld = held.data ? held.data.reduce((sum, r) => sum + (r.status === "success" ? (r.result as bigint) : 0n), 0n) : undefined;
  const retired = retiredQ.data?.[0]?.status === "success" ? (retiredQ.data[0].result as bigint) : undefined;
  const cap = `$${catalog.heldValueCapUsdg.toLocaleString("en-US")}`;
  const count = vaults.length || catalog.launchVaults.length;

  // Live figures when there are any; product facts fill the rest. Nothing ever reads zero.
  const live = [
    { label: "Total held value", value: fmtUsdg(totalHeld, 0), hint: `across ${count} Vaults`, show: nonZero(totalHeld) },
    { label: "Waiting to burn", value: fmtUsdg(queue.usdg, 2), hint: `protocol fees for ${FILL}`, show: nonZero(queue.usdg) },
    { label: `${FILL} burned`, value: fmtAmount(retired, 18, 0), hint: "bought back and burned", show: nonZero(retired) },
  ].filter((f) => deployment && f.show);
  const facts = [
    { label: deployment ? "Live Vaults" : "Vaults at launch", value: String(count), hint: `${cap} cap each` },
    { label: "of fees to Vault holders", value: "70%", hint: "compounds into each share" },
    { label: `buys back and burns ${FILL}`, value: "30%", hint: "capped in the Vault contract" },
    { label: "Held-value cap", value: cap, hint: "per Vault at launch" },
  ];
  const figures = [...live, ...facts].slice(0, 4);

  return (
    <Stats>
      {figures.map((f) => (
        <Stat key={f.label} label={f.label} value={f.value} hint={f.hint} />
      ))}
    </Stats>
  );
}
