"use client";

import { deployments, type Deployment } from "@/generated/vaults/deployments";
import { CHAIN_ID } from "@/lib/config";

export type AppChainId = 4663;

/** The live vault deployment on Robinhood Chain, if one has been exported (launch.sh writes it). Null before launch. */
export function useDeployment(): { deployment: Deployment | null; chainId: AppChainId } {
  return { deployment: (deployments as Record<number, Deployment>)[CHAIN_ID] ?? null, chainId: CHAIN_ID as AppChainId };
}
