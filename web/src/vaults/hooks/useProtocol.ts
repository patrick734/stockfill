"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, parseAbiItem, zeroAddress, type Address } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { buyBurnAbi, vaultOracleAbi, vaultPositionV4Abi } from "@/generated/vaults/abis";
import { useDeployment } from "@/vaults/lib/deployment";
import { BRAND } from "@/lib/brand";

/**
 * $FILL's address. A deployment made before the token launched records none; the token is then read from
 * BuyBurn, where it is set once after the Pons launch. `pending` is true while BuyBurn has no token yet (fees
 * wait there until then). Before any vault deployment, the address from the site's brand file is used, if set.
 */
export function useFillToken(): { token: Address | undefined; pending: boolean } {
  const { deployment, chainId } = useDeployment();
  const fixed = deployment?.fillToken ?? undefined;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment && !fixed), refetchInterval: 20_000 },
    contracts: [{ address: deployment?.buyBurn, abi: buyBurnAbi, chainId, functionName: "fillToken" }],
  });
  const onChain = data?.[0]?.status === "success" ? (data[0].result as Address) : undefined;
  const branded = BRAND.token.address || undefined;
  const token = deployment ? (fixed ?? (onChain && onChain !== zeroAddress ? onChain : undefined)) : branded;
  return { token, pending: Boolean(deployment && !fixed && onChain === zeroAddress) };
}

/**
 * Protocol fees not yet spent on $FILL: USDG and Equity Tokens sitting in the FeeRouter and in BuyBurn,
 * valued at the oracle price.
 */
export function useBurnQueue() {
  const { deployment, chainId } = useDeployment();
  const vaults = deployment ? Object.values(deployment.vaults) : [];
  const holders = deployment ? [deployment.feeRouter, deployment.buyBurn] : [];
  const tokens: Address[] = deployment ? [deployment.usdg, ...vaults.map((w) => w.equityToken)] : [];
  const balances = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: holders.flatMap((h) => tokens.map((t) => ({ address: t, abi: erc20Abi, chainId, functionName: "balanceOf", args: [h] }) as const)),
  });
  const perToken = tokens.map((_, i) =>
    holders.reduce<bigint>((sum, _h, j) => {
      const r = balances.data?.[j * tokens.length + i];
      return sum + (r?.status === "success" ? (r.result as bigint) : 0n);
    }, 0n)
  );
  const valued = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment && balances.data) },
    contracts: tokens.slice(1).map((t, i) => ({ address: deployment?.oracle, abi: vaultOracleAbi, chainId, functionName: "usdgValue", args: [t, perToken[i + 1]] }) as const),
  });
  if (!balances.data) return { usdg: undefined as bigint | undefined, loading: true };
  // Equity valuations revert while prices are stale; count those tokens as unpriced rather than zero.
  const equityValue = (valued.data ?? []).reduce<bigint>((s, r) => s + (r.status === "success" ? (r.result as bigint) : 0n), 0n);
  return { usdg: perToken[0] + equityValue, loading: false };
}

/** The Vault's live Uniswap v4 range: tick bounds and the pool's current tick. Undefined until the position reports a pool. */
export function usePositionRange(position: Address | undefined) {
  const { chainId } = useDeployment();
  const p = { address: position, abi: vaultPositionV4Abi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(position) },
    contracts: [
      { ...p, functionName: "tickLower" },
      { ...p, functionName: "tickUpper" },
      { ...p, functionName: "slot0" },
      { ...p, functionName: "liquidity" },
    ],
  });
  const ok = data?.every((r) => r.status === "success");
  if (!ok) return undefined;
  const slot = data![2].result as readonly [bigint, number];
  return { lower: data![0].result as number, upper: data![1].result as number, tick: slot[1], liquidity: data![3].result as bigint };
}

const rebalanced = parseAbiItem("event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity)");
// Under the public RPC's 500k-block log query limit (450k blocks is 12.5 hours at 0.1 s blocks).
const LOOKBACK = 450_000n;

/** Timestamp of the Vault's most recent rebalance within the RPC's log window, or null if older than that. */
export function useLastRebalance(vault: Address | undefined) {
  const { chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  return useQuery({
    queryKey: ["lastRebalance", chainId, vault],
    enabled: Boolean(client && vault),
    refetchInterval: 120_000,
    queryFn: async (): Promise<number | null> => {
      const head = await client!.getBlockNumber();
      const logs = await client!.getLogs({ address: vault, event: rebalanced, fromBlock: head > LOOKBACK ? head - LOOKBACK : 0n, toBlock: head });
      const last = logs.at(-1);
      if (!last?.blockNumber) return null;
      const block = await client!.getBlock({ blockNumber: last.blockNumber });
      return Number(block.timestamp);
    },
  });
}

/** Price of token1 in token0 at a Uniswap tick, adjusted for decimals. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number) {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}
