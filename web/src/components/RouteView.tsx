"use client";

import { useState } from "react";
import { HopKind, type Plan, type PlanLeg } from "@stockfill/engine";
import { fmt, pct } from "@/lib/format";
import type { Token } from "@/lib/tokens";

const LEG_COLORS = ["var(--leg-1)", "var(--leg-2)", "var(--leg-3)", "var(--leg-4)", "var(--leg-5)"];
const color = (i: number) => LEG_COLORS[i % LEG_COLORS.length];

/** Pool hops of a leg as pill texts: venue and fee, followed by the token handed on when another pool hop comes next. */
function pills(leg: PlanLeg, sym: (a: string) => string): string[] {
  const out: string[] = [];
  const hops = leg.path.hops;
  hops.forEach((h, i) => {
    if (h.kind !== HopKind.V3 && h.kind !== HopKind.V4) return;
    const venue = `v${h.kind === HopKind.V3 ? 3 : 4} ${h.fee / 10000}%`;
    // Name the intermediate token only when another pool hop follows.
    const more = hops.slice(i + 1).some((x) => x.kind === HopKind.V3 || x.kind === HopKind.V4);
    out.push(more ? `${venue} → ${sym(h.tokenOut)}` : venue);
  });
  return out;
}

/**
 * The swap as a flow: the input on the left splits into one band per path, as thick as its share,
 * each band passes its pools, and they merge into the output on the right.
 */
export function RouteView({ plan, tokenIn, tokenOut, symbolOf }: { plan: Plan; tokenIn: Token; tokenOut: Token; symbolOf: (a: string) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const legs = plan.legs;
  const split = legs.length > 1;

  const W = 440;
  const top = 26; // room for end labels
  const rowH = 38;
  const T = Math.min(40, 14 + legs.length * 8); // total thickness at the ends
  const H = top + Math.max(legs.length * rowH, T + 12) + 4;
  const mid = top + (H - top) / 2;
  const x0 = 8; // left anchor right edge
  const x1 = W - 8; // right anchor left edge
  const fanIn = 78;
  const fanOut = W - 78;
  const cx = 34; // curve handle

  const thick = legs.map((l) => Math.max(3, (l.share / 100) * T));
  const sumT = thick.reduce((a, b) => a + b, 0);
  let cursor = mid - sumT / 2;
  const endY = thick.map((t) => {
    const y = cursor;
    cursor += t;
    return y;
  });
  const laneY = legs.map((_, i) => top + rowH * i + rowH / 2 + (Math.max(legs.length * rowH, T + 12) - legs.length * rowH) / 2);

  const ribbon = (i: number) => {
    const t = thick[i];
    const a = endY[i];
    const l = laneY[i] - t / 2;
    // left fan: (x0, a..a+t) -> (fanIn, l..l+t); lane; right fan mirrors
    return [
      `M ${x0} ${a}`,
      `C ${x0 + cx} ${a}, ${fanIn - cx} ${l}, ${fanIn} ${l}`,
      `L ${fanOut} ${l}`,
      `C ${fanOut + cx} ${l}, ${x1 - cx} ${a}, ${x1} ${a}`,
      `L ${x1} ${a + t}`,
      `C ${x1 - cx} ${a + t}, ${fanOut + cx} ${l + t}, ${fanOut} ${l + t}`,
      `L ${fanIn} ${l + t}`,
      `C ${fanIn - cx} ${l + t}, ${x0 + cx} ${a + t}, ${x0} ${a + t}`,
      "Z",
    ].join(" ");
  };

  return (
    <div className="route">
      <div className="route-head">
        <span className="label">Route</span>
        <span className="muted small">
          {split ? `Split across ${legs.length} paths` : "One path"} · {plan.pathsConsidered} considered
        </span>
      </div>

      <svg
        className={`flow${hover !== null ? " hovering" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Swap routed ${legs.map((l) => `${l.share.toFixed(0)}% via ${l.path.label}`).join("; ")}`}
      >
        <text x={0} y={12} className="node-label">
          {tokenIn.symbol}
        </text>
        <text x={W} y={12} className="node-label" textAnchor="end">
          {tokenOut.symbol}
        </text>
        <rect className="end" x={0} y={mid - sumT / 2} width={x0} height={sumT} rx={2} />
        <rect className="end" x={x1} y={mid - sumT / 2} width={W - x1} height={sumT} rx={2} />
        {legs.map((leg, i) => {
          const labels = pills(leg, symbolOf);
          const span = fanOut - fanIn;
          return (
            <g
              key={i}
              className={`band${hover === i ? " on" : ""}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <title>
                {leg.share.toFixed(0)}% · {leg.path.label} · {fmt(leg.amountOut, tokenOut.decimals)} {tokenOut.symbol}
              </title>
              <path d={ribbon(i)} fill={color(i)} opacity={0.88} />
              {/* wide invisible hit area */}
              <rect x={fanIn} y={laneY[i] - rowH / 2} width={span} height={rowH} fill="transparent" />
              {labels.map((text, k) => {
                const w = text.length * 6.3 + 14;
                const cxp = fanIn + (span * (k + 1)) / (labels.length + 1);
                return (
                  <g key={k}>
                    <rect className="hub" x={cxp - w / 2} y={laneY[i] - 9} width={w} height={18} rx={9} />
                    <text x={cxp} y={laneY[i] + 3.6} textAnchor="middle">
                      {text}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      <ul className="route-legs">
        {legs.map((l, i) => (
          <li key={i} className={hover === i ? "on" : ""} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: color(i) }} />
            <span className="share">{l.share.toFixed(0)}%</span>
            <span className="path">{l.path.label}</span>
            <span className="out">
              {fmt(l.amountOut, tokenOut.decimals)} {tokenOut.symbol}
            </span>
          </li>
        ))}
      </ul>

      {split && plan.bestSingle && (
        <p className="route-gain">
          {plan.exactOut ? (
            <>
              Splitting saves <b>{pct(plan.splitGainBps)}</b> over the best single path ({fmt(plan.bestSingle.amountIn, tokenIn.decimals)}{" "}
              {tokenIn.symbol}).
            </>
          ) : (
            <>
              Splitting pays <b>+{pct(plan.splitGainBps)}</b> over the best single path ({fmt(plan.bestSingle.amountOut, tokenOut.decimals)}{" "}
              {tokenOut.symbol}).
            </>
          )}
        </p>
      )}
    </div>
  );
}
