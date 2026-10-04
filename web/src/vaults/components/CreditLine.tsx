"use client";

import { useState } from "react";
import { erc20Abi, formatUnits, maxUint256, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { borrowDeskAbi, vaultAbi } from "@/generated/vaults/abis";
import { TokenDot } from "@/components/TokenDot";
import { useOpenWallet } from "@/components/Wallet";
import { creditSymbol, stockToken, vaultSymbol } from "@/vaults/lib/brand";
import { explorerAddress } from "@/vaults/lib/chains";
import { useDeployment } from "@/vaults/lib/deployment";
import {
  DASH,
  fmtAmount,
  fmtBps,
  fmtHealth,
  fmtUsdg,
  fmtWadPct,
  nonZero,
  safeParse,
  USDG_DECIMALS,
  VAULT_SHARE_DECIMALS,
} from "@/vaults/lib/format";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, KV, Pill, Stat, Stats, Tabs } from "./ui";

const TABS = ["Lend", "Withdraw", "Pledge", "Borrow", "Repay", "Release"] as const;
type Tab = (typeof TABS)[number];

const BLURB: Record<Tab, (t: string) => string> = {
  Lend: (t) => `Lend USDG to borrowers and earn the lend rate. You receive ${creditSymbol(t)} shares.`,
  Withdraw: () => "Take lent USDG back, up to the cash the Credit Line holds right now.",
  Pledge: (t) => `Pledge ${vaultSymbol(t)} as collateral to borrow against.`,
  Borrow: () => "Draw USDG against pledged shares, up to the max LTV. Needs a fresh price. The rate is variable.",
  Repay: () => "Repay any part of your debt at any time. Repaying never waits for a fresh price.",
  Release: (t) => `Take pledged ${vaultSymbol(t)} back. With open debt, what stays pledged must still cover it at the max LTV.`,
};

export function CreditLine({ ticker, desk, vault, usdg }: { ticker: string; desk: Address; vault: Address; usdg: Address }) {
  const { address } = useAccount();
  const openWallet = useOpenWallet();
  const { chainId } = useDeployment();
  const d = { address: desk, abi: borrowDeskAbi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...d, functionName: "totalAssets" },
      { ...d, functionName: "totalDebt" },
      { ...d, functionName: "cash" },
      { ...d, functionName: "utilization" },
      { ...d, functionName: "borrowRatePerYear" },
      { ...d, functionName: "supplyRatePerYear" },
      { ...d, functionName: "risk" },
      { ...d, functionName: "supplyCap" },
      { ...d, functionName: "borrowCap" },
      { ...d, functionName: "paused" },
      { ...d, functionName: "totalCollateralShares" },
      { address: vault, abi: vaultAbi, chainId, functionName: "totalSupply" },
    ],
  });
  const acctQ = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address) },
    contracts: [
      { ...d, functionName: "maxWithdraw", args: [address!] },
      { ...d, functionName: "accounts", args: [address!] },
      { ...d, functionName: "debtOf", args: [address!] },
      { ...d, functionName: "collateralValue", args: [address!] },
      { ...d, functionName: "borrowable", args: [address!] },
      { ...d, functionName: "healthFactor", args: [address!] },
      { address: vault, abi: vaultAbi, chainId, functionName: "balanceOf", args: [address!] },
      { address: usdg, abi: erc20Abi, chainId, functionName: "balanceOf", args: [address!] },
      { ...d, functionName: "maxDeposit", args: [address!] },
    ],
  });
  const g = <T,>(src: readonly { status: string; result?: unknown }[] | undefined, i: number) =>
    src?.[i]?.status === "success" ? (src[i].result as T) : undefined;
  const risk = g<readonly [number, number, number, number, number, number]>(data, 6);
  const paused = g<boolean>(data, 9);
  const supplyCap = g<bigint>(data, 7);
  const borrowCap = g<bigint>(data, 8);
  const utilization = g<bigint>(data, 3);
  const a = acctQ.data;
  const lent = g<bigint>(a, 0);
  const pledged = g<readonly [bigint, bigint]>(a, 1)?.[0];
  const debt = g<bigint>(a, 2);
  const collateral = g<bigint>(a, 3);
  const borrowable = g<bigint>(a, 4);
  const health = g<bigint>(a, 5);
  const vaultShares = g<bigint>(a, 6);
  const usdgBal = g<bigint>(a, 7);
  const maxDeposit = g<bigint>(a, 8);
  const totalPledged = g<bigint>(data, 10);
  const vaultSupply = g<bigint>(data, 11);
  // pledge() caps all pledged shares at maxCollateralShareBps of the Vault's supply.
  const pledgeRoom =
    risk && totalPledged !== undefined && vaultSupply !== undefined
      ? (() => {
          const cap = (vaultSupply * BigInt(risk[4])) / 10_000n;
          return cap > totalPledged ? cap - totalPledged : 0n;
        })()
      : undefined;
  const min = (x: bigint | undefined, y: bigint | undefined) => (x === undefined || y === undefined ? undefined : x < y ? x : y);

  const [tab, setTab] = useState<Tab>("Lend");
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const isShares = tab === "Pledge" || tab === "Release";
  const decimals = isShares ? VAULT_SHARE_DECIMALS : USDG_DECIMALS;
  const parsed = safeParse(amount, decimals);
  const limit: bigint | undefined = {
    Lend: min(usdgBal, maxDeposit),
    Withdraw: lent,
    Pledge: min(vaultShares, pledgeRoom),
    Borrow: borrowable,
    Repay: min(debt, usdgBal),
    Release: pledged,
  }[tab];

  async function submit() {
    if (!parsed || !address) return;
    const me = address;
    const w = tx.writeContractAsync;
    const actions: Record<Tab, () => Promise<void>> = {
      Lend: () =>
        tx.run("Lending", async ({ ensureAllowance }) => {
          await ensureAllowance(usdg, desk, parsed);
          return w({ ...d, functionName: "deposit", args: [parsed, me] });
        }),
      Withdraw: () => tx.run("Withdrawing", () => w({ ...d, functionName: "withdraw", args: [parsed, me, me] })),
      Pledge: () =>
        tx.run("Pledging", async ({ ensureAllowance }) => {
          await ensureAllowance(vault, desk, parsed);
          return w({ ...d, functionName: "pledge", args: [parsed] });
        }),
      Borrow: () => tx.run("Borrowing", () => w({ ...d, functionName: "borrow", args: [parsed, me] })),
      Repay: () =>
        tx.run("Repaying", async ({ ensureAllowance }) => {
          // Interest accrues until the tx lands, so repaying the displayed debt would leave dust that blocks
          // Release. Repaying in full sends maxUint256 (the desk caps it at debtOf) with a small allowance buffer.
          const full = debt !== undefined && parsed >= debt;
          await ensureAllowance(usdg, desk, full ? parsed + parsed / 1000n + 1n : parsed);
          return w({ ...d, functionName: "repay", args: [full ? maxUint256 : parsed, me] });
        }),
      Release: () => tx.run("Releasing", () => w({ ...d, functionName: "release", args: [parsed, me] })),
    };
    await actions[tab]();
    setAmount("");
  }

  const blocked = !address
    ? null
    : paused && (tab === "Lend" || tab === "Pledge" || tab === "Borrow")
      ? "Credit Line paused"
      : parsed !== null && limit !== undefined && parsed > limit
        ? "Amount exceeds available"
        : null;

  // Health after the typed amount, for the actions that change debt or collateral.
  const liq = risk ? BigInt(risk[1]) : undefined;
  const healthOf = (c: bigint, dbt: bigint) => (dbt === 0n ? INFINITE : (c * liq! * 10n ** 18n) / (10_000n * dbt));
  const nextHealth =
    parsed === null || liq === undefined || collateral === undefined || debt === undefined
      ? undefined
      : tab === "Borrow"
        ? healthOf(collateral, debt + parsed)
        : tab === "Repay"
          ? healthOf(collateral, debt > parsed ? debt - parsed : 0n)
          : (tab === "Pledge" || tab === "Release") && pledged
            ? healthOf(
                tab === "Pledge" ? collateral + (collateral * parsed) / pledged : parsed >= pledged ? 0n : collateral - (collateral * parsed) / pledged,
                debt,
              )
            : undefined;

  const supplyHint = nonZero(supplyCap) ? `of ${fmtUsdg(supplyCap, 0)} cap` : undefined;
  const borrowHint = [nonZero(borrowCap) ? `of ${fmtUsdg(borrowCap, 0)} cap` : "", nonZero(utilization) ? `${fmtWadPct(utilization, 0)} used` : ""]
    .filter(Boolean)
    .join(" · ") || undefined;
  const riskLine = risk
    ? [
        risk[0] ? `Max LTV ${fmtBps(risk[0])}` : "",
        risk[1] ? `liquidation at ${fmtBps(risk[1])}` : "",
        risk[2] ? `liquidation bonus ${fmtBps(risk[2])}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "…";
  const showHealth = nonZero(debt) || nonZero(pledged);

  return (
    <div className="vx-stack">
      <div className="vx-card">
        <div className="vx-card-head">
          <div className="vx-title">
            <TokenDot token={stockToken(ticker)} />
            <div>
              <h3>{ticker} Credit Line</h3>
              <p className="small muted">
                Lend USDG for {creditSymbol(ticker)}, or pledge {vaultSymbol(ticker)} and borrow USDG against it.{" "}
                <a href={explorerAddress(desk)} target="_blank" rel="noopener">
                  Contract ↗
                </a>
              </p>
            </div>
          </div>
          {paused === undefined ? null : paused ? <Pill tone="warn">Paused</Pill> : <Pill tone="ok">Open</Pill>}
        </div>
        <Stats>
          <Stat label="Supplied" value={fmtUsdg(g<bigint>(data, 0), 0)} hint={supplyHint} />
          <Stat label="Borrowed" value={fmtUsdg(g<bigint>(data, 1), 0)} hint={borrowHint} />
          <Stat label="Borrow rate" value={fmtWadPct(g<bigint>(data, 4))} hint="variable, per year" />
          <Stat label="Lend rate" value={fmtWadPct(g<bigint>(data, 5))} hint="variable, per year" />
        </Stats>
        {riskLine && <p className="small muted vx-foot">{riskLine}</p>}
      </div>

      <div className="vx-grid">
        <div className="vx-card">
          <h3>Your Credit Line</h3>
          {!address ? (
            <p className="small muted">Connect a wallet to see what you have lent, pledged and borrowed.</p>
          ) : (
            <>
              <div className="vx-kvs">
                <KV k="Lent">{fmtUsdg(lent)}</KV>
                <KV k="Pledged">
                  {nonZero(pledged) ? `${fmtAmount(pledged, VAULT_SHARE_DECIMALS, 2)} ${vaultSymbol(ticker)}${nonZero(collateral) ? ` (${fmtUsdg(collateral)})` : ""}` : pledged === undefined ? "…" : DASH}
                </KV>
                <KV k="Debt">{fmtUsdg(debt)}</KV>
                <KV k="Can still borrow">{fmtUsdg(borrowable)}</KV>
              </div>
              {showHealth && (
                <div className="vx-health">
                  <div className="label">
                    Health ·{" "}
                    <span className={health !== undefined && health < 11n * 10n ** 17n ? "vx-danger" : undefined}>{fmtHealth(health)}</span>
                  </div>
                  <div className="vx-health-track">
                    {nonZero(health) && <span className="vx-health-dot" style={{ left: gaugePos(health) }} />}
                    {nextHealth !== undefined && nextHealth !== health && nextHealth !== 0n && (
                      <span className="vx-health-dot next" style={{ left: gaugePos(nextHealth) }} />
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          <p className="small muted vx-foot">
            Below 1.00, anyone can repay part of your debt and take pledged shares at a discount. Prices pause outside market
            hours and can gap at the open.
          </p>
        </div>

        <div className="vx-panel">
          <Tabs
            tabs={TABS}
            active={tab}
            onChange={(t) => {
              setTab(t);
              setAmount("");
            }}
          />
          <p className="small muted vx-blurb">{BLURB[tab](ticker)}</p>
          <AmountInput
            value={amount}
            onChange={setAmount}
            label={tab}
            symbol={isShares ? vaultSymbol(ticker) : "USDG"}
            max={nonZero(limit) ? fmtAmount(limit, decimals, 2) : undefined}
            onMax={nonZero(limit) ? () => setAmount(formatUnits(limit, decimals)) : undefined}
          />
          {nextHealth !== undefined && (
            <div className="vx-kvs">
              <KV k="Health after" tone={nextHealth < 11n * 10n ** 17n ? "danger" : undefined}>
                {nonZero(health) ? `${fmtHealth(health)} → ` : ""}
                {fmtHealth(nextHealth)}
              </KV>
            </div>
          )}
          {!address ? (
            <button className="vx-cta" onClick={openWallet}>
              Connect wallet
            </button>
          ) : (
            <button className="vx-cta" disabled={!parsed || tx.busy || Boolean(blocked)} onClick={submit}>
              {tx.busy ? tx.message : (blocked ?? (parsed ? tab : "Enter an amount"))}
            </button>
          )}
          <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} hash={tx.busy ? undefined : tx.hash} />
        </div>
      </div>
    </div>
  );
}

const INFINITE = 2n ** 255n;

/** Health on a log scale: 0.70 at the left edge, 1.00 around a quarter of the way, 3.00 and above at the right. */
function gaugePos(h: bigint) {
  const v = Number(formatUnits(h > 10n ** 21n ? 10n ** 21n : h, 18));
  const p = Math.log(Math.max(v, 0.7) / 0.7) / Math.log(3 / 0.7);
  return `${(Math.min(1, Math.max(0, p)) * 100).toFixed(1)}%`;
}
