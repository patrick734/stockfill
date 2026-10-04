"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { erc20Abi, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { txUrl } from "@/lib/config";
import { walletError } from "@/components/Wallet";
import { useDeployment } from "@/vaults/lib/deployment";

type TxState = { busy: boolean; message?: string; error?: string; hash?: Hash };

export function useTx() {
  const { chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  const queryClient = useQueryClient();
  const { address, chainId: walletChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ busy: false });

  async function wait(hash: Hash) {
    if (!client) throw new Error("No RPC client");
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction failed on-chain. Nothing was taken except gas.");
  }

  async function ensureAllowance(token: Address, spender: Address, amount: bigint) {
    if (!client || !address) throw new Error("Connect a wallet first");
    const current = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, spender],
    });
    if (current >= amount) return;
    setState({ busy: true, message: "Approving…" });
    await wait(await writeContractAsync({ address: token, abi: erc20Abi, chainId, functionName: "approve", args: [spender, amount] }));
  }

  async function run(label: string, steps: (helpers: { ensureAllowance: typeof ensureAllowance }) => Promise<Hash>) {
    setState({ busy: true, message: `${label}…` });
    try {
      if (walletChain !== chainId) {
        setState({ busy: true, message: "Switch your wallet to Robinhood Chain…" });
        await switchChainAsync({ chainId });
      }
      const hash = await steps({ ensureAllowance });
      setState({ busy: true, message: `${label}: confirming…`, hash });
      await wait(hash);
      setState({ busy: false, message: `${label}: confirmed.`, hash });
      await queryClient.invalidateQueries();
    } catch (e) {
      setState({ busy: false, error: walletError(e) });
    }
  }

  return { ...state, run, writeContractAsync };
}

export function TxStatus({ message, error, hash }: { message?: string; error?: string; hash?: Hash }) {
  if (error) return <p className="err small vx-tx">{error}</p>;
  if (message)
    return (
      <p className="ok small vx-tx">
        {message}{" "}
        {hash && (
          <a href={txUrl(hash)} target="_blank" rel="noopener">
            View transaction ↗
          </a>
        )}
      </p>
    );
  return null;
}
