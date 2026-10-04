import type { ReactNode } from "react";

/** A headline figure: display serif number over a small label, like the home page's figures. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="vx-stat">
      <div className="vx-stat-v">{value}</div>
      <div className="vx-stat-l">{label}</div>
      {hint && <div className="vx-stat-h">{hint}</div>}
    </div>
  );
}

export function Stats({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return <div className={`vx-stats c${cols}`}>{children}</div>;
}

/** One label and value row, in the swap card's "facts" style. */
export function KV({ k, children, tone }: { k: ReactNode; children: ReactNode; tone?: "good" | "danger" | "warn" }) {
  return (
    <div className="vx-kv">
      <span>{k}</span>
      <span className={tone ? `vx-${tone}` : undefined}>{children}</span>
    </div>
  );
}

export function AmountInput({
  value,
  onChange,
  label,
  symbol,
  max,
  onMax,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  symbol: string;
  max?: string;
  onMax?: () => void;
}) {
  return (
    <div className="vx-field">
      <div className="vx-field-top">
        <span className="label">{label}</span>
        {onMax && max && (
          <button type="button" className="vx-bal" onClick={onMax}>
            Available {max} · Max
          </button>
        )}
      </div>
      <div className="vx-field-row">
        <input
          inputMode="decimal"
          placeholder="Amount"
          aria-label={`${label} in ${symbol}`}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        <span className="vx-sym">{symbol}</span>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: readonly T[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="vx-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={t === active} className={t === active ? "on" : ""} onClick={() => onChange(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}

/** Shown wherever a live contract would be, until the vault contracts are deployed. */
export function NotDeployed({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <div className="vx-card vx-soon-card">
      <span className="vx-pill muted">Launching soon</span>
      <h3>{what} open at launch.</h3>
      <p>Contract addresses and live numbers appear here as soon as the Stockfill vault contracts are deployed on Robinhood Chain.</p>
      {children}
    </div>
  );
}

export type Tone = "ok" | "warn" | "bad" | "muted" | "burn";

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`vx-pill ${tone}`}>{children}</span>;
}

/** Section heading in the site's style: mono label, serif headline, a short line on the right. */
export function SectionHead({ label, title, children }: { label: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-head">
      <span className="label">{label}</span>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : <span />}
    </div>
  );
}
