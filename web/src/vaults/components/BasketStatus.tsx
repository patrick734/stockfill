"use client";

import { useState } from "react";
import { erc20Abi, formatUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { basketProgramAbi } from "@/generated/vaults/abis";
import { useOpenWallet } from "@/components/Wallet";
import { explorerAddress } from "@/vaults/lib/chains";
import { useDeployment } from "@/vaults/lib/deployment";
import { DASH, fmtAmount, fmtUsdg, nonZero, safeParse, USDG_DECIMALS, VAULT_SHARE_DECIMALS } from "@/vaults/lib/format";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, KV, Pill, SectionHead, Stat, Stats, Tabs } from "./ui";

const TABS = ["Deposit", "Withdraw", "Redeem in kind"] as const;

/** The Basket: one USDG deposit spread across every Vault, with its own deposit, withdraw and in-kind exits. */
export function BasketStatus() {
  const { deployment, chainId } = useDeployment();
  const basket = deployment?.basketProgram as Address | undefined;
  const b = { address: basket, abi: basketProgramAbi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(basket) },
    contracts: [
      { ...b, functionName: "totalAssets" },
      { ...b, functionName: "heldValueCap" },
      { ...b, functionName: "vaults" },
      { ...b, functionName: "maxAllocationBps" },
      { ...b, functionName: "pricesUsable" },
      { ...b, functionName: "paused" },
      { address: deployment?.usdg, abi: erc20Abi, chainId, functionName: "balanceOf", args: [basket!] },
    ],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const total = r<bigint>(0);
  const cap = r<bigint>(1);
  const vaults = r<readonly Address[]>(2);
  const usable = r<boolean>(4);
  const paused = r<boolean>(5);
  const idle = r<bigint>(6);
  const open = cap !== undefined && cap > 0n;

  return (
    <section className="section" id="basket">
      <SectionHead label="Basket" title={<>One deposit, <em>every Vault.</em></>}>
        The keeper spreads one USDG deposit across every Vault, keeps about a fifth in USDG for withdrawals and never puts
        more than {r<number>(3) !== undefined ? `${(r<number>(3)! / 100).toFixed(0)}%` : "40%"} into one Vault. No fee of its own.
      </SectionHead>
      {!deployment || !basket ? (
        <div className="vx-card">
          <p className="small muted">Opens with the vault contracts.</p>
        </div>
      ) : (
        <div className="vx-grid">
          <div className="vx-card">
            <div className="vx-card-head">
              <h3>Basket</h3>
              {cap === 0n ? (
                <Pill tone="muted">Opens after the 48h timelock handoff</Pill>
              ) : paused ? (
                <Pill tone="warn">Depositing paused</Pill>
              ) : usable === false ? (
                <Pill tone="warn">Prices closed · exits in kind only</Pill>
              ) : open ? (
                <Pill tone="ok">Open</Pill>
              ) : (
                <Pill tone="muted">Closed</Pill>
              )}
            </div>
            <Stats cols={3}>
              <Stat label="Held value" value={total === undefined && usable === false ? "Prices stale" : fmtUsdg(total, 0)} hint={nonZero(cap) ? `of ${fmtUsdg(cap, 0)} cap` : undefined} />
              <Stat label="Kept in USDG" value={nonZero(total) && idle !== undefined ? `${((Number(idle) / Number(total)) * 100).toFixed(0)}%` : "About 20%"} hint="for instant withdrawals" />
              <Stat label="Vaults" value={vaults ? String(vaults.length) : "…"} />
            </Stats>
            <p className="small muted">
              USDG deposits and withdrawals wait while any Vault the Basket holds has a stale price or a pool more than 2% off
              Chainlink. Redeeming in kind always works: you get your slice of the USDG plus your slice of every Vault&apos;s shares.
            </p>
            <p className="small vx-links">
              <a href={explorerAddress(basket)} target="_blank" rel="noopener">
                Basket contract ↗
              </a>
            </p>
          </div>
          <BasketPanel basket={basket} usdg={deployment.usdg} usable={usable} paused={paused} closed={cap === 0n} />
        </div>
      )}
    </section>
  );
}

function BasketPanel({ basket, usdg, usable, paused, closed }: { basket: Address; usdg: Address; usable?: boolean; paused?: boolean; closed?: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Deposit");
  const [amount, setAmount] = useState("");
  const { address } = useAccount();
  const { chainId } = useDeployment();
  const openWallet = useOpenWallet();
  const tx = useTx();
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address) },
    contracts: [
      { address: basket, abi: basketProgramAbi, chainId, functionName: "balanceOf", args: [address!] },
      { address: basket, abi: basketProgramAbi, chainId, functionName: "maxWithdraw", args: [address!] },
      { address: basket, abi: basketProgramAbi, chainId, functionName: "maxDeposit", args: [address!] },
      { address: usdg, abi: erc20Abi, chainId, functionName: "balanceOf", args: [address!] },
      { address: basket, abi: basketProgramAbi, chainId, functionName: "convertToAssets", args: [10n ** BigInt(VAULT_SHARE_DECIMALS)] },
    ],
  });
  const r = (i: number) => (data?.[i]?.status === "success" ? (data[i].result as bigint) : undefined);
  const shares = r(0);
  const maxWithdraw = r(1);
  const maxDeposit = r(2);
  const wallet = r(3);
  const sharePrice = r(4);
  const worth = shares !== undefined && sharePrice !== undefined ? (shares * sharePrice) / 10n ** BigInt(VAULT_SHARE_DECIMALS) : undefined;

  const isShares = tab === "Redeem in kind";
  const decimals = isShares ? VAULT_SHARE_DECIMALS : USDG_DECIMALS;
  const parsed = safeParse(amount, decimals);
  const limit = tab === "Deposit" ? min(maxDeposit, wallet) : tab === "Withdraw" ? maxWithdraw : shares;
  const over = parsed !== null && limit !== undefined && parsed > limit;

  async function submit() {
    if (!parsed || !address) return;
    const me = address;
    if (tab === "Deposit") {
      await tx.run("Depositing", async ({ ensureAllowance }) => {
        await ensureAllowance(usdg, basket, parsed);
        return tx.writeContractAsync({ address: basket, abi: basketProgramAbi, chainId, functionName: "deposit", args: [parsed, me] });
      });
    } else if (tab === "Withdraw") {
      await tx.run("Withdrawing", async () =>
        tx.writeContractAsync({ address: basket, abi: basketProgramAbi, chainId, functionName: "withdraw", args: [parsed, me, me] }),
      );
    } else {
      await tx.run("Redeeming in kind", async () =>
        tx.writeContractAsync({ address: basket, abi: basketProgramAbi, chainId, functionName: "redeemInKind", args: [parsed, me, me] }),
      );
    }
    setAmount("");
  }

  const disabledReason = !address
    ? null
    : tab === "Deposit" && closed
      ? "Deposits open after the 48h timelock handoff"
      : tab === "Deposit" && paused
      ? "Depositing is paused"
      : tab !== "Redeem in kind" && usable === false
        ? "Prices closed: use Redeem in kind"
        : over
          ? "Amount exceeds available"
          : null;

  return (
    <div className="vx-panel">
      <div className="vx-panel-head">
        <b>Basket</b>
        <span className="mono small muted">sfBASKET</span>
      </div>
      <Tabs
        tabs={TABS}
        active={tab}
        onChange={(t) => {
          setTab(t);
          setAmount("");
        }}
      />
      <p className="small muted vx-blurb">
        {tab === "Deposit" && "Deposit USDG. You receive sfBASKET shares; the keeper puts the USDG to work across the Vaults."}
        {tab === "Withdraw" && "Exit to USDG from the Basket's USDG reserve. Larger exits wait for the keeper to refill it, or redeem in kind."}
        {tab === "Redeem in kind" && "Available any time. You receive your slice of the Basket's USDG plus your slice of every Vault's shares."}
      </p>
      <AmountInput
        value={amount}
        onChange={setAmount}
        label={tab === "Redeem in kind" ? "Redeem" : tab}
        symbol={isShares ? "sfBASKET" : "USDG"}
        max={nonZero(limit) ? fmtAmount(limit, decimals, 2) : undefined}
        onMax={nonZero(limit) ? () => setAmount(formatUnits(limit, decimals)) : undefined}
      />
      {address && (
        <div className="vx-kvs">
          <KV k="Your shares">{nonZero(shares) ? `${fmtAmount(shares, VAULT_SHARE_DECIMALS, 2)} sfBASKET` : shares === undefined ? "…" : DASH}</KV>
          <KV k="Your position">{nonZero(worth) ? fmtUsdg(worth) : worth === undefined ? (usable === false && nonZero(shares) ? "Prices stale" : "…") : DASH}</KV>
          <KV k="Wallet USDG">{fmtUsdg(wallet)}</KV>
        </div>
      )}
      {!address ? (
        <button className="vx-cta" onClick={openWallet}>
          Connect wallet
        </button>
      ) : (
        <button className="vx-cta" disabled={!parsed || tx.busy || Boolean(disabledReason)} onClick={submit}>
          {tx.busy ? tx.message : (disabledReason ?? (!parsed ? "Enter an amount" : tab === "Deposit" ? "Deposit into the Basket" : tab))}
        </button>
      )}
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} hash={tx.busy ? undefined : tx.hash} />
    </div>
  );
}

function min(a?: bigint, b?: bigint) {
  if (a === undefined || b === undefined) return undefined;
  return a < b ? a : b;
}
