import { formatUnits, parseUnits } from "viem";

// Display rule for every vault page: a zero is never shown. Formatters return DASH for zero and LOADING while loading.
export const DASH = "—";
export const LOADING = "…";

export const USDG_DECIMALS = 6;
export const VAULT_SHARE_DECIMALS = 12;
export const WAD = 10n ** 18n;

export function fmtUsdg(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  const n = Number(formatUnits(value, USDG_DECIMALS));
  const s = n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // A dust amount that rounds to $0.00 still reads as zero.
  if (Number(s.replace(/,/g, "")) === 0) return `<$${(10 ** -digits).toFixed(digits)}`;
  return `$${s}`;
}

export function fmtAmount(value: bigint | undefined, decimals: number, digits = 4): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  const n = Number(formatUnits(value, decimals));
  const s = n.toLocaleString("en-US", { maximumFractionDigits: digits });
  if (Number(s.replace(/,/g, "")) === 0) return `<${(10 ** -digits).toFixed(digits)}`;
  return s;
}

/** A fraction (0.042 = 4.2%) as a percent, or DASH when it rounds to zero. */
export function fmtRate(value: number | null | undefined, digits = 1): string {
  if (value === undefined) return LOADING;
  if (value === null || !Number.isFinite(value)) return DASH;
  const s = (value * 100).toFixed(digits);
  return Number(s) === 0 ? DASH : `${s}%`;
}

export function fmtWadPct(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  return fmtRate(Number(formatUnits(value, 18)), digits);
}

export function fmtBps(bps: number | bigint | undefined): string {
  if (bps === undefined) return LOADING;
  if (Number(bps) === 0) return DASH;
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function fmtHealth(value: bigint | undefined): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  if (value > 1000n * WAD) return "∞";
  return Number(formatUnits(value, 18)).toFixed(2);
}

/** True when a value is loaded and not zero: the guard for any element that would otherwise read zero. */
export const nonZero = (v: bigint | undefined): v is bigint => v !== undefined && v !== 0n;

export function safeParse(input: string, decimals: number): bigint | null {
  if (!input || !/^\d*\.?\d*$/.test(input) || input === ".") return null;
  try {
    const [w, f = ""] = input.split(".");
    const v = parseUnits(`${w || "0"}.${f.slice(0, decimals)}`, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function shortAddress(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
