"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { marketSnapshot, NATIVE, type MarketRow, type V4PoolKey } from "@stockfill/engine";
import { CHAIN_ID, ENGINE } from "./config";
import type { Token } from "./tokens";

const REFRESH = 30_000;
const lower = (a: string) => a.toLowerCase();

export type Markets = {
  rows: Map<string, MarketRow>;
  /** USD price for any listed token (USDG = 1, ETH = WETH). */
  usd: (address: string) => number | undefined;
  loading: boolean;
  updatedAt: number | null;
};

/** Live board for every listed token, priced by real quotes in USDG. */
export function useMarkets(tokens: Token[], v4Pools: V4PoolKey[]): Markets {
  const client = usePublicClient({ chainId: CHAIN_ID }) as PublicClient | undefined;
  const [rows, setRows] = useState<Map<string, MarketRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const usdg = ENGINE.hubs[0];
  const priced = useMemo(
    () => tokens.filter((t) => lower(t.address) !== lower(usdg) && t.address !== NATIVE),
    [tokens, usdg],
  );

  useEffect(() => {
    if (!client || priced.length === 0) return;
    let dead = false;
    const run = async () => {
      try {
        const list = await marketSnapshot(
          client,
          ENGINE,
          usdg,
          priced.map((t) => ({ address: t.address, decimals: t.decimals })),
          v4Pools,
          1000,
          (a) => tokens.find((t) => lower(t.address) === lower(a))?.symbol ?? (a === NATIVE ? "ETH" : a.slice(0, 6)),
        );
        if (dead) return;
        setRows(new Map(list.map((r) => [lower(r.token), r])));
        setUpdatedAt(Date.now());
      } catch {
        /* keep the last board */
      } finally {
        if (!dead) setLoading(false);
      }
    };
    run();
    const t = setInterval(() => document.visibilityState === "visible" && run(), REFRESH);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [client, priced, v4Pools, usdg, tokens]);

  const usd = (address: string) => {
    if (lower(address) === lower(usdg)) return 1;
    const key = address === NATIVE ? lower(ENGINE.weth) : lower(address);
    return rows.get(key)?.price;
  };

  return { rows, usd, loading, updatedAt };
}
