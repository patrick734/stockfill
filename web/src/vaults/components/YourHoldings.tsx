"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { basketProgramAbi, borrowDeskAbi, vaultAbi, fillTokenAbi } from "@/generated/vaults/abis";
import { TokenDot } from "@/components/TokenDot";
import { useOpenWallet } from "@/components/Wallet";
import { useFillToken } from "@/vaults/hooks/useProtocol";
import { FILL, stockToken, vaultSymbol } from "@/vaults/lib/brand";
import { useDeployment } from "@/vaults/lib/deployment";
import { DASH, fmtAmount, fmtUsdg, nonZero, VAULT_SHARE_DECIMALS } from "@/vaults/lib/format";
import { routes } from "@/vaults/lib/links";
import { NotDeployed, Stat, Stats } from "./ui";

type Result = { status: string; result?: unknown };
const get = <T,>(src: readonly Result[] | undefined, i: number) => (src?.[i]?.status === "success" ? (src[i].result as T) : undefined);

export function YourHoldings() {
  const { deployment, chainId } = useDeployment();
  const { address } = useAccount();
  const vaults = deployment ? Object.entries(deployment.vaults) : [];
  const desks = deployment ? (Object.entries(deployment.creditLines) as [string, Address][]) : [];
  const enabled = Boolean(deployment && address);
  const me = address!;

  const { token: fillAddress, pending: fillPending } = useFillToken();
  const t = { address: fillAddress, abi: fillTokenAbi, chainId } as const;
  const token = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(fillAddress) },
    contracts: [
      { ...t, functionName: "balanceOf", args: [me] },
      { ...t, functionName: "totalSupply" },
      { ...t, functionName: "decimals" },
    ],
  });
  const fillBalance = get<bigint>(token.data, 0);
  const fillSupply = get<bigint>(token.data, 1);
  const fillDecimals = get<number>(token.data, 2) ?? 18;

  const shares = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: vaults.map(([, w]) => ({ address: w.vault, abi: vaultAbi, chainId, functionName: "balanceOf", args: [me] }) as const),
  });
  const vaultShares = vaults.map((_, i) => get<bigint>(shares.data, i));
  const vaultValuesQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(shares.data) },
    contracts: vaults.map(([, w], i) => ({ address: w.vault, abi: vaultAbi, chainId, functionName: "convertToAssets", args: [vaultShares[i] ?? 0n] }) as const),
  });
  const vaultValues = vaults.map((_, i) => get<bigint>(vaultValuesQ.data, i));

  const bp = { address: deployment?.basketProgram, abi: basketProgramAbi, chainId } as const;
  const basketSharesQ = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: [{ ...bp, functionName: "balanceOf", args: [me] }],
  });
  const basketShares = get<bigint>(basketSharesQ.data, 0);
  const basketValueQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && basketShares !== undefined },
    contracts: [{ ...bp, functionName: "convertToAssets", args: [basketShares ?? 0n] }],
  });
  const basketValue = get<bigint>(basketValueQ.data, 0);

  // Lender shares are valued with convertToAssets, not maxWithdraw, which is capped by the desk's free cash.
  const deskSharesQ = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: desks.map(([, desk]) => ({ address: desk, abi: borrowDeskAbi, chainId, functionName: "balanceOf", args: [me] }) as const),
  });
  const deskShares = desks.map((_, i) => get<bigint>(deskSharesQ.data, i));
  const desksQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(deskSharesQ.data) },
    contracts: desks.flatMap(([, desk], i) => [
      { address: desk, abi: borrowDeskAbi, chainId, functionName: "convertToAssets", args: [deskShares[i] ?? 0n] } as const,
      { address: desk, abi: borrowDeskAbi, chainId, functionName: "collateralValue", args: [me] } as const,
      { address: desk, abi: borrowDeskAbi, chainId, functionName: "debtOf", args: [me] } as const,
    ]),
  });
  const deskRows = desks.map(([ticker], i) => ({
    ticker,
    lent: get<bigint>(desksQ.data, i * 3),
    collateral: get<bigint>(desksQ.data, i * 3 + 1),
    debt: get<bigint>(desksQ.data, i * 3 + 2),
  }));

  const sum = (xs: (bigint | undefined)[]) => xs.reduce<bigint>((s, x) => s + (x ?? 0n), 0n);
  const totalDebt = desksQ.data ? sum(deskRows.map((d) => d.debt)) : undefined;
  // Distinguish "you hold nothing" from "couldn't read the chain", so an unreachable RPC never shows as empty.
  const queries = [token, shares, basketSharesQ, deskSharesQ];
  const unreachable = queries.some((q) => q.isError || (q.data !== undefined && q.data.length > 0 && q.data.every((x) => x.status !== "success")));
  const loadingLists = !shares.data || !deskSharesQ.data;
  const loaded = vaultValuesQ.data && basketValueQ.data && desksQ.data;
  // Vault and collateral valuations revert while the oracle price is stale (market closed); don't count those as zero.
  const failed = (q: readonly Result[] | undefined) => q?.some((x) => x.status !== "success") ?? false;
  const priced = !failed(vaultValuesQ.data) && !failed(basketValueQ.data) && !failed(desksQ.data);
  const netValue =
    loaded && priced ? sum([...vaultValues, basketValue, ...deskRows.map((d) => d.lent), ...deskRows.map((d) => d.collateral)]) - (totalDebt ?? 0n) : undefined;
  const supplyPct = (() => {
    if (!nonZero(fillBalance) || !nonZero(fillSupply)) return undefined;
    const pct = Number((fillBalance * 1_000_000n) / fillSupply) / 10_000;
    return pct >= 0.0001 ? `${pct.toFixed(4)}% of supply` : "under 0.0001% of supply";
  })();

  if (!deployment) return <NotDeployed what="Vaults and Credit Lines" />;
  if (!address) {
    return (
      <div className="vx-card">
        <h3>Your holdings</h3>
        <p className="muted">Connect a wallet to see your {FILL} balance, Vault shares and Credit Line positions.</p>
        <ConnectNow />
      </div>
    );
  }

  const heldVaults = vaults.map(([ticker, w], i) => ({ ticker, name: w.name, shares: vaultShares[i], value: vaultValues[i] })).filter((w) => nonZero(w.shares));
  const activeDesks = deskRows.filter((d) => nonZero(d.lent) || nonZero(d.collateral) || nonZero(d.debt));

  return (
    <div className="vx-stack">
      {unreachable && <p className="err small">Couldn&apos;t read your positions from the network. Check your connection or RPC and try again.</p>}
      <Stats cols={3}>
        <Stat
          label="Net position"
          value={netValue !== undefined && netValue < 0n ? `−${fmtUsdg(-netValue)}` : fmtUsdg(netValue)}
          hint={loaded && !priced ? "unavailable while prices are stale" : "Vaults + lent − debt"}
        />
        <Stat label="Credit Line debt" value={fmtUsdg(totalDebt)} hint={nonZero(totalDebt) ? "repay any time" : "no open debt"} />
        <Stat
          label={`${FILL} balance`}
          value={fillPending || !fillAddress ? DASH : fmtAmount(fillBalance, fillDecimals, 2)}
          hint={fillPending || !fillAddress ? "launching soon on Pons" : supplyPct}
        />
      </Stats>

      <div className="vx-card">
        <h3>Vaults</h3>
        {loadingLists || unreachable ? (
          <p className="small muted">{unreachable ? "Unavailable" : "Loading…"}</p>
        ) : heldVaults.length === 0 && !nonZero(basketShares) ? (
          <p className="small muted">
            No Vault shares yet. <Link href={routes.vaults}>Browse Vaults</Link>
          </p>
        ) : null}
        {heldVaults.map((w) => {
          // Shares start at 1 USDG each, so value per share above 1.00 is the Vault's growth since launch.
          const perShare = w.value !== undefined && w.shares ? Number((w.value * 10n ** 12n * 10_000n) / w.shares) / 10_000 / 1e6 : undefined;
          const growth = perShare !== undefined ? (perShare - 1) * 100 : undefined;
          return (
            <Link key={w.ticker} href={routes.vault(w.ticker)} className="vx-holding">
              <TokenDot token={stockToken(w.ticker, w.name)} />
              <span>
                <b>
                  {fmtAmount(w.shares, VAULT_SHARE_DECIMALS, 2)} {vaultSymbol(w.ticker)}
                </b>
                <span className="small muted">{w.ticker} Vault</span>
              </span>
              <span className="vx-holding-v">
                {fmtUsdg(w.value)}
                {growth !== undefined && Math.abs(growth) >= 0.005 && (
                  <span className={growth >= 0 ? "vx-good" : "vx-danger"}>
                    {growth >= 0 ? "+" : ""}
                    {growth.toFixed(2)}% per share
                  </span>
                )}
              </span>
            </Link>
          );
        })}
        {nonZero(basketShares) ? (
          <Link href={routes.vaults} className="vx-holding">
            <span className="tk-dot">B</span>
            <span>
              <b>Basket Program</b>
              <span className="small muted">sfBASKET</span>
            </span>
            <span className="vx-holding-v">{fmtUsdg(basketValue)}</span>
          </Link>
        ) : null}

        <h3 className="vx-mt">Credit Lines</h3>
        {!desksQ.data || unreachable ? (
          <p className="small muted">{unreachable ? "Unavailable" : desks.length === 0 ? "Credit Lines open soon." : "Loading…"}</p>
        ) : activeDesks.length === 0 ? (
          <p className="small muted">
            No Credit Line positions. <Link href={routes.borrow}>Credit Lines</Link>
          </p>
        ) : null}
        {activeDesks.map((d) => {
          const parts = [nonZero(d.lent) ? `lent ${fmtUsdg(d.lent)}` : "", nonZero(d.collateral) ? `pledged ${fmtUsdg(d.collateral)}` : ""].filter(Boolean);
          return (
            <Link key={d.ticker} href={routes.borrow} className="vx-holding">
              <TokenDot token={stockToken(d.ticker)} />
              <span>
                <b>{d.ticker} Credit Line</b>
                {parts.length > 0 && <span className="small muted">{parts.join(" · ")}</span>}
              </span>
              <span className="vx-holding-v">
                {nonZero(d.debt) ? (
                  <>
                    {fmtUsdg(d.debt)}
                    <span className="muted">debt</span>
                  </>
                ) : (
                  <span className="muted">no debt</span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function ConnectNow() {
  const open = useOpenWallet();
  return (
    <button className="btn" onClick={open}>
      Connect wallet
    </button>
  );
}
