"use client";

import Link from "next/link";
import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { TokenDot } from "@/components/TokenDot";
import { useOpenWallet } from "@/components/Wallet";
import { useLastRebalance, usePositionRange, tickToPrice } from "@/vaults/hooks/useProtocol";
import { useVaultAccount, useVaultStats, useYieldRate } from "@/vaults/hooks/useVault";
import { vaultAbi, vaultOracleAbi, vaultPositionV4Abi } from "@/generated/vaults/abis";
import { catalog } from "@/generated/vaults/catalog";
import { FILL, stockName, stockToken, vaultSymbol } from "@/vaults/lib/brand";
import { explorerAddress } from "@/vaults/lib/chains";
import { useDeployment } from "@/vaults/lib/deployment";
import { DASH, fmtAmount, fmtBps, fmtRate, fmtUsdg, nonZero, safeParse, USDG_DECIMALS, VAULT_SHARE_DECIMALS } from "@/vaults/lib/format";
import { routes } from "@/vaults/lib/links";
import { MarketChip } from "./MarketChip";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, KV, NotDeployed, Pill, Stat, Stats, Tabs } from "./ui";

const TABS = ["Deposit", "Withdraw", "Redeem in kind"] as const;
const ONE_EQUITY = 10n ** 18n;

export function VaultDetail({ ticker }: { ticker: string }) {
  const { deployment } = useDeployment();
  const entry = deployment?.vaults[ticker];
  const name = entry?.name ?? stockName(ticker);
  const vault = entry?.vault;
  const s = useVaultStats(vault);
  const y = useYieldRate(vault, s.heldValue, s.equityToken, s.oracle);
  // Shares start at exactly 1 USDG each, so share value above 1.00 is the Vault's return since launch.
  const growth = s.sharePrice !== undefined ? (Number(formatUnits(s.sharePrice, USDG_DECIMALS)) - 1) * 100 : undefined;

  return (
    <>
      <div className="vx-hero">
        <Link href={routes.vaults} className="vx-back">
          ← All Vaults
        </Link>
        <div className="pills">
          <span className="pill">
            <TokenDot token={stockToken(ticker, name)} /> {name} Stock Token / USDG
          </span>
          <MarketChip />
        </div>
        <div className="vx-hero-row">
          <h1>
            {ticker} <em>Vault</em>
          </h1>
          {vault &&
            (s.paused ? (
              <Pill tone="warn">Depositing paused</Pill>
            ) : s.priceFresh === false ? (
              <Pill tone="warn">Market closed · exits in kind only</Pill>
            ) : s.priceFresh ? (
              <Pill tone="ok">Open · price fresh</Pill>
            ) : null)}
        </div>
        <p className="lede">
          Deposit USDG and receive {vaultSymbol(ticker)} shares. The Vault provides {ticker} liquidity around Chainlink&apos;s
          price and earns a fee on every trade through its range.
        </p>
      </div>

      {!deployment || !vault || !entry ? (
        <NotDeployed what={`The ${ticker} Vault and the other Vaults`}>
          <p className="small muted">
            Each Vault opens with a ${catalog.heldValueCapUsdg.toLocaleString("en-US")} held-value cap.{" "}
            <Link href={routes.vaults}>See all Vaults</Link>
          </p>
        </NotDeployed>
      ) : (
        <>
          <Stats>
            <Stat label="Held value" value={fmtUsdg(s.heldValue, 0)} hint={nonZero(s.cap) ? `of ${fmtUsdg(s.cap, 0)} cap` : undefined} />
            <Stat label="Yield rate" value={y.data ? fmtRate(y.data) : DASH} hint="recent fees, annualized" />
            <Stat
              label="Share value"
              value={nonZero(s.sharePrice) ? `$${Number(formatUnits(s.sharePrice, USDG_DECIMALS)).toFixed(4)}` : s.sharePrice === undefined ? "…" : DASH}
              hint={growth !== undefined && Math.abs(growth) >= 0.005 ? `${growth >= 0 ? "+" : ""}${growth.toFixed(2)}% since launch` : `per ${vaultSymbol(ticker)}`}
            />
            <Stat label="Protocol share" value={fmtBps(s.protocolShareBps)} hint={`buys back and burns ${FILL}`} />
          </Stats>
          <div className="vx-grid vx-mt">
            <WorkingCard ticker={ticker} vault={vault} position={entry.position} equity={entry.equityToken} usdg={deployment.usdg} oracle={deployment.oracle} stats={s} />
            <DepositPanel vault={vault} usdg={deployment.usdg} ticker={ticker} stats={s} />
          </div>
        </>
      )}
    </>
  );
}

function WorkingCard({
  ticker,
  vault,
  position,
  equity,
  usdg,
  oracle,
  stats,
}: {
  ticker: string;
  vault: Address;
  position: Address;
  equity: Address;
  usdg: Address;
  oracle: Address;
  stats: ReturnType<typeof useVaultStats>;
}) {
  const { chainId } = useDeployment();
  const range = usePositionRange(position);
  const last = useLastRebalance(vault);
  const { data: prices } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: position, abi: vaultPositionV4Abi, chainId, functionName: "spotUsdgValue", args: [ONE_EQUITY] },
      { address: oracle, abi: vaultOracleAbi, chainId, functionName: "usdgValue", args: [equity, ONE_EQUITY] },
    ],
  });
  const spot = prices?.[0]?.status === "success" ? Number(formatUnits(prices[0].result as bigint, USDG_DECIMALS)) : undefined;
  const oraclePx = prices?.[1]?.status === "success" ? Number(formatUnits(prices[1].result as bigint, USDG_DECIMALS)) : undefined;
  const drift = spot && oraclePx ? ((spot - oraclePx) / oraclePx) * 100 : undefined;

  return (
    <div className="vx-card">
      <h3>Where the Vault is working</h3>
      {range && range.liquidity > 0n ? (
        <RangeBar {...range} equityIsToken0={BigInt(equity) < BigInt(usdg)} />
      ) : (
        <p className="small muted">
          {range ? "No range placed yet. New deposits go to work at the next rebalance." : "The live range appears here once the Vault trades on Uniswap v4."}
        </p>
      )}
      <p className="small muted">
        The keeper keeps this band centred on the Chainlink price and moves it when {ticker} drifts toward an edge. Trades
        inside the band pay fees to the Vault.
      </p>
      <div className="vx-kvs">
        <KV k={`${ticker} held`}>{fmtAmount(stats.equityHeld, 18)}</KV>
        <KV k="USDG held">{fmtUsdg(stats.usdgHeld)}</KV>
        {drift !== undefined && <KV k="Pool vs Chainlink">{Math.abs(drift) < 0.005 ? "in line" : `${drift >= 0 ? "+" : ""}${drift.toFixed(2)}%`}</KV>}
        <KV k="Last rebalance">{fmtAgo(last.data)}</KV>
      </div>
      <p className="small vx-links">
        <a href={explorerAddress(vault)} target="_blank" rel="noopener">Vault contract ↗</a>
        <a href={explorerAddress(position)} target="_blank" rel="noopener">Position ↗</a>
        <a href={explorerAddress(equity)} target="_blank" rel="noopener">{ticker} token ↗</a>
      </p>
    </div>
  );
}

function RangeBar({ lower, upper, tick, equityIsToken0 }: { lower: number; upper: number; tick: number; equityIsToken0: boolean }) {
  // Prices in USDG per Stock Token. Tick prices are token1 per token0, so invert when USDG is token0.
  const toUsdg = (t: number) => (equityIsToken0 ? tickToPrice(t, 18, 6) : 1 / tickToPrice(t, 6, 18));
  const a = toUsdg(lower);
  const b = toUsdg(upper);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const now = toUsdg(tick);
  const pad = (hi - lo) * 0.6;
  const min = Math.min(lo - pad, now);
  const max = Math.max(hi + pad, now);
  const pos = (p: number) => `${(((p - min) / (max - min)) * 100).toFixed(2)}%`;
  const inRange = now >= lo && now <= hi;
  const money = (p: number) => `$${p.toLocaleString("en-US", { maximumFractionDigits: p >= 100 ? 0 : 2 })}`;

  return (
    <div className="vx-range">
      <div className="label">{inRange ? "Active range on Uniswap v4" : "Price is outside the range: rebalance due"}</div>
      <div className="vx-range-bar">
        <div className="vx-range-band" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
        <div className={inRange ? "vx-range-mark" : "vx-range-mark out"} style={{ left: pos(now) }} />
        <span className="vx-range-tag" style={{ left: pos(lo) }}>{money(lo)}</span>
        <span className="vx-range-tag now" style={{ left: pos(now) }}>{money(now)}</span>
        <span className="vx-range-tag" style={{ left: pos(hi) }}>{money(hi)}</span>
      </div>
    </div>
  );
}

function fmtAgo(ts: number | null | undefined) {
  if (ts === undefined) return "…";
  if (ts === null) return "over 12h ago";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function DepositPanel({ vault, usdg, ticker, stats }: { vault: Address; usdg: Address; ticker: string; stats: ReturnType<typeof useVaultStats> }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Deposit");
  const [amount, setAmount] = useState("");
  const acct = useVaultAccount(vault, usdg);
  const openWallet = useOpenWallet();
  const tx = useTx();
  const { chainId } = useDeployment();
  const sym = vaultSymbol(ticker);

  const isShares = tab === "Redeem in kind";
  const decimals = isShares ? VAULT_SHARE_DECIMALS : USDG_DECIMALS;
  const parsed = safeParse(amount, decimals);
  const limit = tab === "Deposit" ? min(acct.maxDeposit, acct.usdgBalance) : tab === "Withdraw" ? acct.maxWithdraw : acct.shares;
  const over = parsed !== null && limit !== undefined && parsed > limit;

  async function submit() {
    if (!parsed || !acct.address) return;
    const me = acct.address;
    if (tab === "Deposit") {
      await tx.run("Depositing", async ({ ensureAllowance }) => {
        await ensureAllowance(usdg, vault, parsed);
        return tx.writeContractAsync({ address: vault, abi: vaultAbi, chainId, functionName: "deposit", args: [parsed, me] });
      });
    } else if (tab === "Withdraw") {
      const all = acct.maxWithdraw !== undefined && parsed === acct.maxWithdraw && acct.shares !== undefined;
      await tx.run("Withdrawing", async () =>
        all
          ? tx.writeContractAsync({ address: vault, abi: vaultAbi, chainId, functionName: "redeem", args: [acct.shares!, me, me] })
          : tx.writeContractAsync({ address: vault, abi: vaultAbi, chainId, functionName: "withdraw", args: [parsed, me, me] }),
      );
    } else {
      const supply = stats.totalSupply ?? 0n;
      const minEquity = supply && stats.equityHeld ? (stats.equityHeld * parsed * 98n) / (supply * 100n) : 0n;
      const minUsdg = supply && stats.usdgHeld ? (stats.usdgHeld * parsed * 98n) / (supply * 100n) : 0n;
      await tx.run("Redeeming in kind", async () =>
        tx.writeContractAsync({ address: vault, abi: vaultAbi, chainId, functionName: "redeemInKind", args: [parsed, me, me, minEquity, minUsdg] }),
      );
    }
    setAmount("");
  }

  const disabledReason = !acct.address
    ? null
    : tab === "Deposit" && stats.paused
      ? "Depositing is paused"
      : tab !== "Redeem in kind" && stats.priceFresh === false
        ? "Price feed closed: use Redeem in kind"
        : over
          ? "Amount exceeds available"
          : null;

  return (
    <div className="vx-panel">
      <div className="vx-panel-head">
        <b>{ticker} Vault</b>
        <span className="mono small muted">{sym}</span>
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
        {tab === "Deposit" && `Deposit USDG. You receive ${sym} shares that track your slice of the Vault.`}
        {tab === "Withdraw" &&
          "Exit to USDG. The Vault sells Stock Token as needed within its swap-loss limit (1% by default). You pay that cost, not the holders who stay."}
        {tab === "Redeem in kind" &&
          `Available even when markets are closed or depositing is paused. You receive your share of the Vault's ${ticker} Stock Token and USDG directly.`}
      </p>
      <AmountInput
        value={amount}
        onChange={setAmount}
        label={tab === "Redeem in kind" ? "Redeem" : tab}
        symbol={isShares ? sym : "USDG"}
        max={nonZero(limit) ? fmtAmount(limit, decimals, 2) : undefined}
        onMax={nonZero(limit) ? () => setAmount(formatUnits(limit, decimals)) : undefined}
      />
      {acct.address && (
        <div className="vx-kvs">
          <KV k="Your shares">{nonZero(acct.shares) ? `${fmtAmount(acct.shares, VAULT_SHARE_DECIMALS, 2)} ${sym}` : acct.shares === undefined ? "…" : DASH}</KV>
          <KV k="Your position">{fmtUsdg(acct.maxWithdraw)}</KV>
          <KV k="Wallet USDG">{fmtUsdg(acct.usdgBalance)}</KV>
        </div>
      )}
      {!acct.address ? (
        <button className="vx-cta" onClick={openWallet}>
          Connect wallet
        </button>
      ) : (
        <button className="vx-cta" disabled={!parsed || tx.busy || Boolean(disabledReason)} onClick={submit}>
          {tx.busy ? tx.message : (disabledReason ?? (!parsed ? "Enter an amount" : tab === "Deposit" ? `Deposit into the ${ticker} Vault` : tab))}
        </button>
      )}
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} hash={tx.busy ? undefined : tx.hash} />
      {tab === "Deposit" && <p className="small muted vx-foot">Withdraw in USDG any time the price is fresh. Redeem in kind works even when markets are closed.</p>}
    </div>
  );
}

function min(a?: bigint, b?: bigint) {
  if (a === undefined || b === undefined) return undefined;
  return a < b ? a : b;
}
