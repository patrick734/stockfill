"use client";

import { useBurnQueue, useFillToken } from "@/vaults/hooks/useProtocol";
import { FILL } from "@/vaults/lib/brand";
import { useDeployment } from "@/vaults/lib/deployment";
import { fmtUsdg, nonZero } from "@/vaults/lib/format";
import { tradeUrl } from "@/vaults/lib/links";
import { SectionHead } from "./ui";

const C = 2 * Math.PI * 40;

export function FeeSplit() {
  const { deployment } = useDeployment();
  const queue = useBurnQueue();
  const { token, pending } = useFillToken();
  const waiting = nonZero(queue.usdg) ? queue.usdg : undefined;

  return (
    <section className="section">
      <SectionHead label="Fees" title={<>Where every fee <em>dollar goes.</em></>}>
        70% of trading fees compounds for Vault holders. 30% buys back and burns {FILL}. Both limits live in the contracts.
      </SectionHead>
      <div className="vx-split">
        <div className="vx-ring">
          <svg viewBox="0 0 100 100" role="img" aria-label={`70% of fees to Vault holders, 30% to ${FILL} buy-back and burn`}>
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--paper-2)" strokeWidth="12" />
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent)" strokeWidth="12" strokeDasharray={`${C * 0.7} ${C}`} transform="rotate(-90 50 50)" />
            <circle
              cx="50" cy="50" r="40" fill="none" stroke="var(--ink)" strokeWidth="12"
              strokeDasharray={`${C * 0.3} ${C}`} strokeDashoffset={-C * 0.7} transform="rotate(-90 50 50)"
            />
            <text x="50" y="52" textAnchor="middle" fill="var(--ink)" fontFamily="var(--f-display)" fontSize="19">70/30</text>
            <text x="50" y="63" textAnchor="middle" fill="var(--muted)" fontFamily="var(--f-mono)" fontSize="4.6" letterSpacing="0.4">ON-CHAIN</text>
          </svg>
          <div className="vx-legend">
            <div><i style={{ background: "var(--accent)" }} /><div><b>70%</b><span>compounds for Vault holders</span></div></div>
            <div><i style={{ background: "var(--ink)" }} /><div><b>30%</b><span>buys back and burns {FILL}</span></div></div>
            <div><i style={{ background: "var(--rule-2)" }} /><div><b>48h</b><span>public timelock on governance changes</span></div></div>
          </div>
        </div>
        <div className="vx-burn">
          <span className="label">{FILL} buy-back and burn</span>
          <div className="vx-burn-big">{!deployment ? "Starts at launch" : waiting ? `${fmtUsdg(waiting)} waiting` : "Ready to burn"}</div>
          <p>
            The protocol&apos;s share is capped at 30% in the Vault contract: governance can lower it, never set it above 30%. The
            burn contract has no withdrawal function, so fees only leave it as burned {FILL}.
          </p>
          <a className="vx-burn-btn" href={tradeUrl(token)} target="_blank" rel="noopener">
            {pending || !token ? `${FILL} launching on Pons ↗` : `Trade ${FILL} on Pons ↗`}
          </a>
        </div>
      </div>
    </section>
  );
}
