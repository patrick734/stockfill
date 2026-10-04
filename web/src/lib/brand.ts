import { deployments } from "@/generated/vaults/deployments";

/** $FILL as plugged into the live vault deployment by set-token.sh (Robinhood Chain), if any. */
const deployedFill = (deployments as Record<number, { fillToken?: string | null }>)[4663]?.fillToken ?? "";

/** Everything brand-specific, kept in one file. */
export const BRAND = {
  name: "Stockfill",
  /** Short line under the name (footer, meta). */
  tagline: "Tokenized stocks, filled at the best price across every pool on Robinhood Chain.",
  domain: process.env.NEXT_PUBLIC_DOMAIN || "",
  x: process.env.NEXT_PUBLIC_X_URL || "",
  telegram: "",
  /** The project token. Launched on Pons from the dev wallet; set-token.sh records it (and wins over the env var).
   *  Until an address is set, the site says it has not launched. */
  token: {
    symbol: process.env.NEXT_PUBLIC_TOKEN_SYMBOL || "FILL",
    address: (/^0x[0-9a-fA-F]{40}$/.test(deployedFill)
      ? deployedFill
      : /^0x[0-9a-fA-F]{40}$/.test((process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "").trim())
        ? (process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? "").trim()
        : "") as `0x${string}` | "",
  },
};
