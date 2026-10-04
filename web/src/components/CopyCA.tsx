"use client";

import { useState } from "react";
import { BRAND } from "@/lib/brand";
import { addressUrl } from "@/lib/config";

/** The project token's contract address, one tap to copy. Before launch it says so instead. */
export function CopyCA({ variant = "bar" }: { variant?: "bar" | "dark" }) {
  const [copied, setCopied] = useState(false);
  const { symbol, address } = BRAND.token;

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Older browsers / insecure context: fall back to a hidden textarea.
      const t = document.createElement("textarea");
      t.value = address;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`ca-bar ${variant}${address ? "" : " soon"}`}>
      <b>${symbol}</b>
      {address ? (
        <a className="ca-addr mono" href={addressUrl(address)} target="_blank" rel="noopener" title="View on explorer">
          <span className="ca-full">{address}</span>
          <span className="ca-short">
            {address.slice(0, 8)}…{address.slice(-6)}
          </span>
        </a>
      ) : (
        <span className="ca-addr">Launching on Pons. The official address appears here first.</span>
      )}
      {address && (
        <button className="ca-copy" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
