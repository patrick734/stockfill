import { formatUnits, parseUnits } from "viem";

/** Human amount: 1,234.56 / 0.004213, never scientific notation. */
export function fmt(value: bigint | undefined, decimals = 18, maxSig = 6): string {
  if (value === undefined) return "—";
  const n = Number(formatUnits(value, decimals));
  return num(n, maxSig);
}

export function num(n: number | undefined, maxSig = 6): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: maxSig });
}

export function usd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/** Parses a typed amount; undefined if it isn't valid. */
export function parseAmount(s: string, decimals: number): bigint | undefined {
  if (!s || !/^\d*\.?\d*$/.test(s) || s === ".") return undefined;
  try {
    const [w, f = ""] = s.split(".");
    return parseUnits(`${w || "0"}.${f.slice(0, decimals)}`, decimals);
  } catch {
    return undefined;
  }
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const pct = (bps: number) => `${(bps / 100).toFixed(bps < 10 ? 2 : bps < 1000 ? 2 : 1)}%`;
