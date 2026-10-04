"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address, PublicClient } from "viem";
import { findRoute, type Plan, type V4PoolKey } from "@stockfill/engine";
import { CHAIN_ID, ENGINE } from "./config";
import type { Token } from "./tokens";

export const REFRESH_MS = 15_000;

export type RouteState = {
  plan: Plan | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  noRoute: boolean;
};

const EMPTY: RouteState = { plan: null, loading: false, error: null, updatedAt: null, noRoute: false };

/**
 * Live best route: debounced while typing, refreshed every 15 seconds. `amount` is the amount paid,
 * or with `exactOut` the amount received.
 */
export function useRoute(
  tokenIn: Token | undefined,
  tokenOut: Token | undefined,
  amount: bigint | undefined,
  exactOut: boolean,
  v4Pools: V4PoolKey[],
  slippageBps: number,
  symbols: Map<string, string>,
) {
  const client = usePublicClient({ chainId: CHAIN_ID }) as PublicClient | undefined;
  const [state, setState] = useState<RouteState>(EMPTY);
  const req = useRef(0);

  const run = useCallback(async () => {
    if (!client || !tokenIn || !tokenOut || !amount || tokenIn.address === tokenOut.address) {
      req.current++;
      setState(EMPTY);
      return;
    }
    const id = ++req.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { plan } = await findRoute(client, ENGINE, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        ...(exactOut ? { amountOut: amount } : { amountIn: amount }),
        v4Pools,
        slippageBps,
        symbol: (a: Address) => symbols.get(a.toLowerCase()) ?? `${a.slice(0, 6)}…`,
      });
      if (id !== req.current) return;
      setState({ plan, loading: false, error: null, updatedAt: Date.now(), noRoute: !plan });
    } catch (e) {
      if (id !== req.current) return;
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
      setState((s) => ({ ...s, loading: false, error: msg || "Quote failed" }));
    }
  }, [client, tokenIn, tokenOut, amount, exactOut, v4Pools, slippageBps, symbols]);

  useEffect(() => {
    const t = setTimeout(run, 350);
    return () => clearTimeout(t);
  }, [run]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [run]);

  return { ...state, refresh: run };
}
