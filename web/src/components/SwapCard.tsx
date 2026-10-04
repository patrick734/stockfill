"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Hex, type PublicClient } from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  erc20Abi,
  permit2TypedData,
  permitTypedData,
  randomPermit2Nonce,
  readPermitDomain,
  routerAbi,
  splitSignature,
  swapCall,
  tradeArgs,
  NATIVE,
  type PermitDomain,
  type Plan,
  type V4PoolKey,
} from "@stockfill/engine";
import { CHAIN_ID, ROUTER, txUrl } from "@/lib/config";
import { fmt, parseAmount, pct, usd } from "@/lib/format";
import type { Markets } from "@/lib/useMarkets";
import type { Token } from "@/lib/tokens";
import { REFRESH_MS, useRoute } from "@/lib/useRoute";
import { RouteView } from "./RouteView";
import { TokenPicker } from "./TokenPicker";
import { TokenDot } from "./TokenDot";
import { useOpenWallet, walletError } from "./Wallet";

const SLIPPAGES = [10, 50, 100];
const ZERO = "0x0000000000000000000000000000000000000000";

export type Preset = { out?: Token; in?: Token; nonce: number };

/** How the router gets the input: already approved, a signature, or an approval first. */
type Payment = "native" | "allowance" | "permit" | "permit2" | "approve";

export function SwapCard({
  tokens,
  v4Pools,
  markets,
  preset,
}: {
  tokens: Token[];
  v4Pools: V4PoolKey[];
  markets: Markets;
  preset?: Preset;
}) {
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID }) as PublicClient | undefined;
  const openWallet = useOpenWallet();
  const { switchChain, isPending: switching } = useSwitchChain();

  const bySymbol = (s: string) => tokens.find((t) => t.symbol === s);
  const [tokenIn, setTokenIn] = useState<Token | undefined>();
  const [tokenOut, setTokenOut] = useState<Token | undefined>();
  const [amountStr, setAmountStr] = useState("");
  // The field typed in last: "out" means buy exactly that amount.
  const [side, setSide] = useState<"in" | "out">("in");
  const [slippageBps, setSlippageBps] = useState(50);
  const [picking, setPicking] = useState<"in" | "out" | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const resolve = (cur: Token | undefined, fallback: Token | undefined) =>
      (cur && (tokens.find((t) => t.address.toLowerCase() === cur.address.toLowerCase()) ?? bySymbol(cur.symbol))) ??
      fallback;
    setTokenIn((cur) => resolve(cur, bySymbol("USDG") ?? tokens[0]));
    setTokenOut((cur) => resolve(cur, bySymbol("NVDA") ?? tokens.find((t) => t.kind === "stock")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens]);

  useEffect(() => {
    if (!preset) return;
    if (preset.in) setTokenIn(preset.in);
    if (preset.out) {
      setTokenOut(preset.out);
      if (!preset.in && tokenIn?.address === preset.out.address) setTokenIn(bySymbol("USDG"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  const exactOut = side === "out";
  const typedToken = exactOut ? tokenOut : tokenIn;
  const symbols = useMemo(() => new Map(tokens.map((t) => [t.address.toLowerCase(), t.symbol])), [tokens]);
  const amount = typedToken ? parseAmount(amountStr, typedToken.decimals) : undefined;
  const route = useRoute(tokenIn, tokenOut, amount, exactOut, v4Pools, slippageBps, symbols);
  const plan: Plan | null =
    route.plan && amount && route.plan.exactOut === exactOut && (exactOut ? route.plan.amountOut : route.plan.amountIn) === amount
      ? route.plan
      : null;
  const pull = plan?.maxAmountIn;

  // Balances and approvals
  const isNativeIn = tokenIn?.address === NATIVE;
  const erc20In = tokenIn && !isNativeIn ? tokenIn.address : undefined;
  const ethBal = useBalance({ address, chainId: CHAIN_ID, query: { enabled: !!address } });
  const tokBal = useReadContract({
    address: erc20In,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!erc20In },
  });
  const balance = isNativeIn ? ethBal.data?.value : (tokBal.data as bigint | undefined);

  const routerAllowance = useReadContract({
    address: erc20In,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && ROUTER ? [address, ROUTER] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!ROUTER && !!erc20In },
  });
  const permit2Read = useReadContract({ address: ROUTER, abi: routerAbi, functionName: "permit2", chainId: CHAIN_ID, query: { enabled: !!ROUTER } });
  const permit2 = permit2Read.data && permit2Read.data !== ZERO ? (permit2Read.data as `0x${string}`) : undefined;
  const permit2Allowance = useReadContract({
    address: erc20In,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && permit2 ? [address, permit2] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!permit2 && !!erc20In },
  });

  // EIP-2612 support of the input token, with the wallet's current nonce.
  const [permit, setPermit] = useState<{ domain: PermitDomain; nonce: bigint } | null | undefined>();
  const [permitKey, setPermitKey] = useState(0);
  useEffect(() => {
    setPermit(undefined);
    if (!client || !address || !erc20In) return;
    let dead = false;
    readPermitDomain(client, erc20In, address, CHAIN_ID).then(
      (p) => !dead && setPermit(p),
      () => !dead && setPermit(null),
    );
    return () => {
      dead = true;
    };
  }, [client, address, erc20In, permitKey]);

  let payment: Payment | undefined;
  if (isNativeIn) payment = "native";
  else if (pull !== undefined && routerAllowance.data !== undefined) {
    if ((routerAllowance.data as bigint) >= pull) payment = "allowance";
    else if (permit) payment = "permit";
    else if (permit === undefined) payment = undefined;
    else if (permit2 && permit2Allowance.data !== undefined && (permit2Allowance.data as bigint) >= pull) payment = "permit2";
    else payment = "approve";
  }

  // Transactions
  const { writeContractAsync, data: hash, isPending, reset } = useWriteContract();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const receipt = useWaitForTransactionReceipt({ hash });
  // What the last transaction was, captured when it was sent.
  const [last, setLast] = useState<{ kind: "approve" | "swap"; exactOut: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!receipt.isSuccess) return;
    routerAllowance.refetch();
    permit2Allowance.refetch();
    tokBal.refetch();
    ethBal.refetch();
    setPermitKey((k) => k + 1);
    route.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  const busy = isPending || signing || receipt.isLoading;
  const start = (kind: "approve" | "swap") => {
    reset();
    setError(null);
    setLast({ kind, exactOut });
  };
  const fail = (e: unknown) => setError(walletError(e));

  const approve = async () => {
    if (!erc20In || pull === undefined || !ROUTER) return;
    start("approve");
    // The exact amount, never unlimited.
    await writeContractAsync({ address: erc20In, abi: erc20Abi, functionName: "approve", args: [ROUTER, pull], chainId: CHAIN_ID }).catch(fail);
  };

  const swap = async () => {
    if (!plan || !address || !ROUTER) return;
    start("swap");
    try {
      if (payment === "permit" && permit && client && erc20In) {
        const { trade, legs, pull } = tradeArgs(plan, address);
        // The nonce moves with every permit the wallet signs anywhere, so read it now.
        const fresh = (await readPermitDomain(client, erc20In, address, CHAIN_ID)) ?? permit;
        const sig = await signTypedDataAsync(
          permitTypedData({ domain: fresh.domain, owner: address, spender: ROUTER, value: pull, nonce: fresh.nonce, deadline: trade.deadline }),
        );
        const { v, r, s } = splitSignature(sig as Hex);
        await writeContractAsync({
          address: ROUTER,
          abi: routerAbi,
          functionName: "swapWithPermit",
          args: [trade, legs, { value: pull, deadline: trade.deadline, v, r, s }],
          chainId: CHAIN_ID,
        });
      } else if (payment === "permit2" && permit2 && erc20In) {
        const { trade, legs, pull } = tradeArgs(plan, address);
        const nonce = randomPermit2Nonce();
        const signature = await signTypedDataAsync(
          permit2TypedData({ chainId: CHAIN_ID, token: erc20In, amount: pull, spender: ROUTER, nonce, deadline: trade.deadline, permit2 }),
        );
        await writeContractAsync({
          address: ROUTER,
          abi: routerAbi,
          functionName: "swapWithPermit2",
          args: [trade, legs, { amount: pull, nonce, deadline: trade.deadline, signature }],
          chainId: CHAIN_ID,
        });
      } else {
        await writeContractAsync({ address: ROUTER, abi: routerAbi, ...swapCall(plan, address), chainId: CHAIN_ID } as never);
      }
    } catch (e) {
      fail(e);
    }
  };

  const typeIn = (s: string, which: "in" | "out") => {
    setSide(which);
    setAmountStr(s.replace(/[^0-9.]/g, ""));
    setError(null);
    if (last?.kind === "swap") reset();
  };

  // The other side keeps its token: an amount typed for USDG stays on USDG after the flip.
  const flip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setSide(exactOut ? "in" : "out");
    reset();
    setError(null);
  };

  let cta = "Enter an amount";
  let action: (() => void) | null = null;
  if (!tokenIn || !tokenOut) cta = "Select tokens";
  else if (!amount) cta = "Enter an amount";
  else if (route.noRoute) cta = "No route for this size";
  else if (!plan) cta = route.loading ? "Finding the best route…" : "Getting a quote…";
  else if (!ROUTER) cta = "Swaps open when the router is live";
  else if (!isConnected) {
    cta = "Connect wallet";
    action = openWallet;
  } else if (chainId !== CHAIN_ID) {
    cta = switching ? "Check your wallet…" : "Switch to Robinhood Chain";
    action = () => switchChain({ chainId: CHAIN_ID });
  } else if (balance !== undefined && pull !== undefined && pull > balance) cta = `Not enough ${tokenIn.symbol}`;
  else if (busy) cta = signing ? "Sign in your wallet…" : "Confirm in your wallet…";
  else if (payment === undefined) cta = "Checking approval…";
  else if (payment === "approve") {
    cta = `Approve ${fmt(pull, tokenIn.decimals)} ${tokenIn.symbol}`;
    action = approve;
  } else {
    const verb = exactOut ? "buy" : "swap";
    cta = payment === "permit" || payment === "permit2" ? `Sign and ${verb}` : exactOut ? "Buy" : "Swap";
    action = swap;
  }

  const rate =
    plan && tokenIn && tokenOut
      ? Number(formatUnits(plan.amountOut, tokenOut.decimals)) / Number(formatUnits(plan.amountIn, tokenIn.decimals))
      : undefined;

  const payText = exactOut ? (plan && tokenIn ? fmt(plan.amountIn, tokenIn.decimals) : "") : amountStr;
  const getText = exactOut ? amountStr : plan && tokenOut ? fmt(plan.amountOut, tokenOut.decimals) : "";
  const paid = plan?.amountIn ?? (!exactOut ? amount : undefined);
  const got = plan?.amountOut ?? (exactOut ? amount : undefined);
  const usdIn = tokenIn ? markets.usd(tokenIn.address) : undefined;
  const usdOut = tokenOut ? markets.usd(tokenOut.address) : undefined;
  const valIn = usdIn !== undefined && paid && tokenIn ? usdIn * Number(formatUnits(paid, tokenIn.decimals)) : undefined;
  const valOut = usdOut !== undefined && got && tokenOut ? usdOut * Number(formatUnits(got, tokenOut.decimals)) : undefined;
  const quoting = route.loading;

  return (
    <div className="swap" id="swap">
      <div className="swap-head">
        <div className="swap-tabs">
          <b>{exactOut ? "Buy exactly" : "Swap"}</b>
          <span className="label">best execution</span>
        </div>
        <div className="swap-tools">
          <QuoteClock updatedAt={route.updatedAt} loading={quoting} />
          <button className="chip" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>
            Slippage {pct(slippageBps)}
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="settings">
          <span className="muted small">
            Max slippage. The swap reverts if you would {exactOut ? "pay more" : "receive less"}.
          </span>
          <div className="seg">
            {SLIPPAGES.map((s) => (
              <button key={s} className={s === slippageBps ? "on" : ""} onClick={() => setSlippageBps(s)}>
                {pct(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <div className="field-top">
          <span className="label">You pay</span>
          {balance !== undefined && tokenIn && (
            <button
              className="bal small"
              onClick={() => typeIn(trimNum(formatUnits(isNativeIn ? reserveGas(balance) : balance, tokenIn.decimals)), "in")}
            >
              Balance {fmt(balance, tokenIn.decimals)} · Max
            </button>
          )}
        </div>
        <div className="field-row">
          <input
            className={`amount mono${exactOut && quoting ? " dim" : ""}${sizeClass(payText)}`}
            inputMode="decimal"
            placeholder="0"
            value={payText}
            onChange={(e) => typeIn(e.target.value, "in")}
            aria-label="Amount to pay"
          />
          <button className="token-btn" onClick={() => setPicking("in")}>
            <TokenDot token={tokenIn} />
            {tokenIn?.symbol ?? "Select"} <span className="caret" aria-hidden="true">▼</span>
          </button>
        </div>
        {valIn !== undefined && <div className="usd">≈ {usd(valIn)}</div>}
      </div>

      <div className="flip-row">
        <button className="flip" onClick={flip} aria-label="Swap direction">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M4 1v11M4 12l-3-3M4 12l3-3M10 13V2M10 2L7 5M10 2l3 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="field">
        <div className="field-top">
          <span className="label">{exactOut ? "You receive exactly" : "You receive"}</span>
          {valOut !== undefined && <span className="usd">≈ {usd(valOut)}</span>}
        </div>
        <div className="field-row">
          <input
            className={`amount mono${!exactOut && quoting ? " dim" : ""}${sizeClass(getText)}`}
            inputMode="decimal"
            placeholder="0"
            value={getText}
            onChange={(e) => typeIn(e.target.value, "out")}
            aria-label="Amount to receive"
          />
          <button className="token-btn" onClick={() => setPicking("out")}>
            <TokenDot token={tokenOut} />
            {tokenOut?.symbol ?? "Select"} <span className="caret" aria-hidden="true">▼</span>
          </button>
        </div>
      </div>

      {plan && tokenIn && tokenOut && (
        <dl className="facts">
          <div>
            <dt>Rate</dt>
            <dd>
              1 {tokenIn.symbol} = {rate !== undefined ? rate.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "—"} {tokenOut.symbol}
            </dd>
          </div>
          <div>
            <dt>Price impact</dt>
            <dd className={plan.impactBps > 300 ? "warn" : plan.impactBps < 30 ? "good" : ""}>{pct(plan.impactBps)}</dd>
          </div>
          {exactOut ? (
            <div>
              <dt>Maximum spent</dt>
              <dd>
                {fmt(plan.maxAmountIn, tokenIn.decimals)} {tokenIn.symbol} <span className="muted">· the rest is refunded</span>
              </dd>
            </div>
          ) : (
            <div>
              <dt>Minimum received</dt>
              <dd>
                {fmt(plan.minAmountOut, tokenOut.decimals)} {tokenOut.symbol}
              </dd>
            </div>
          )}
          {(payment === "permit" || payment === "permit2") && (
            <div>
              <dt>Approval</dt>
              <dd className="good">One signature, this swap only</dd>
            </div>
          )}
          <div>
            <dt>Router fee</dt>
            <dd className="good">0%</dd>
          </div>
        </dl>
      )}

      {plan && tokenIn && tokenOut && (
        <RouteView plan={plan} tokenIn={tokenIn} tokenOut={tokenOut} symbolOf={(a) => (a === NATIVE ? "ETH" : symbols.get(a.toLowerCase()) ?? a.slice(0, 6))} />
      )}

      {plan && plan.impactBps > 300 && (
        <p className="warn-box small">
          This trade moves the price by {pct(plan.impactBps)}. The pools are thin next to a large exchange; a smaller size
          gets a better rate.
        </p>
      )}
      {route.error && <p className="err small">Quote failed: {route.error}</p>}

      <button className="cta" disabled={!action || busy} onClick={action ?? undefined}>
        {cta}
      </button>

      {error && <p className="err small">{error}</p>}
      {receipt.isSuccess && hash && last && (
        <p className="ok small">
          {last.kind === "approve" ? (
            <>
              {tokenIn?.symbol} approved. <b>Now press {exactOut ? "Buy" : "Swap"}.</b>{" "}
            </>
          ) : last.exactOut ? (
            <>Bought. Anything unspent came back in the same transaction. </>
          ) : (
            <>Swapped. </>
          )}
          <a href={txUrl(hash)} target="_blank" rel="noopener">
            View transaction ↗
          </a>
        </p>
      )}
      {receipt.isError && <p className="err small">The transaction failed on-chain. Nothing was taken except gas.</p>}

      {picking && (
        <TokenPicker
          tokens={tokens}
          markets={markets}
          exclude={picking === "in" ? tokenOut?.address : tokenIn?.address}
          onClose={() => setPicking(null)}
          onPick={(t) => {
            if (picking === "in") setTokenIn(t);
            else setTokenOut(t);
            setPicking(null);
            reset();
          }}
        />
      )}
    </div>
  );
}

/** How fresh the quote is. It refreshes itself every 15 seconds. */
function QuoteClock({ updatedAt, loading }: { updatedAt: number | null; loading: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (loading) return <span className="clock muted mono">quoting…</span>;
  if (!updatedAt) return null;
  const leftMs = Math.max(0, REFRESH_MS - (now - updatedAt));
  const c = 2 * Math.PI * 6;
  return (
    <span className="clock muted mono" title="Quotes refresh against live pools every 15 seconds">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" fill="none" strokeWidth="2" />
        <circle className="left" cx="8" cy="8" r="6" fill="none" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - leftMs / REFRESH_MS)} />
      </svg>
      live
    </span>
  );
}

/** Long numbers get a smaller font instead of being cut off. */
function sizeClass(s: string): string {
  return s.length > 14 ? " xlong" : s.length > 10 ? " long" : "";
}

function trimNum(s: string): string {
  if (!s.includes(".")) return s;
  const [w, f] = s.split(".");
  const cut = f.slice(0, 8).replace(/0+$/, "");
  return cut ? `${w}.${cut}` : w;
}

/** Keeps a little ETH for gas when Max is used on native ETH. */
function reserveGas(v: bigint): bigint {
  const keep = 2_000_000_000_000_000n;
  return v > keep ? v - keep : 0n;
}
