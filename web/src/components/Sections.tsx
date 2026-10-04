"use client";

import { BRAND } from "@/lib/brand";
import { QUOTER, ROUTER, addressUrl } from "@/lib/config";
import { deployments } from "@/generated/vaults/deployments";
import { CopyCA } from "./CopyCA";

/** Ten slots, coloured by the path that won each tenth of the trade. */
function Tenths() {
  const legs = [1, 1, 1, 2, 1, 3, 2, 1, 3, 1];
  return (
    <div className="tenths" aria-hidden="true">
      {legs.map((l, i) => (
        <i key={i} style={{ height: `${40 + i * 6}%`, background: `var(--leg-${l})` }} />
      ))}
    </div>
  );
}

export function HowItFills() {
  const steps = [
    {
      n: "01",
      t: "Find",
      d: "Every Uniswap v3 and v4 pool that trades your pair, directly or through USDG or ETH. Pools with no liquidity at the current price, or priced more than 10% away from the deepest one, are dropped.",
    },
    {
      n: "02",
      t: "Simulate",
      d: "Each path is run as a real swap against the live pools inside a read-only call, then thrown away. What you see is what the pools would pay, or charge, right now.",
    },
    {
      n: "03",
      t: "Fill",
      d: "The trade is handed out a tenth at a time to whichever path does best on that tenth. Paths that share a pool are never combined, and a split is used only if it beats the best single path.",
    },
  ];
  return (
    <section id="how" className="section wrap">
      <div className="section-head">
        <span className="label">How it fills</span>
        <h2>
          One trade, <em>ten slices,</em> every pool.
        </h2>
        <p>
          A big trade moves a single pool against you. Spreading it over the pools that trade the same pair gets you more,
          whether you sell an exact amount or buy one.
        </p>
      </div>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.n}>
            <span className="step-n">{s.n}</span>
            <h3>{s.t}</h3>
            {s.n === "03" && <Tenths />}
            <p>{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Deployment = {
  timelock?: string;
  oracle?: string;
  swapAdapter?: string;
  buyBurn?: string;
  feeRouter?: string;
  registry?: string;
  basketProgram?: string;
  vaults?: Record<string, { vault: string }>;
  creditLines?: Record<string, string>;
};

export function Contracts() {
  const d = (deployments as Record<number, Deployment>)[4663];
  const rows: [string, string | undefined][] = [
    ["RouterStockfill", ROUTER],
    ["QuoterStockfill", QUOTER],
    ["TimelockStockfill (48h)", d?.timelock],
    ["OracleStockfill", d?.oracle],
    ["BuyBurnStockfill", d?.buyBurn],
    ["FeeRouterStockfill", d?.feeRouter],
    ["SwapAdapterStockfill", d?.swapAdapter],
    ["RegistryStockfill", d?.registry],
    ...Object.entries(d?.vaults ?? {}).map(([t, v]) => [`VaultStockfill · ${t}`, v.vault] as [string, string]),
    ...Object.entries(d?.creditLines ?? {}).map(([t, v]) => [`BorrowDeskStockfill · ${t}`, v] as [string, string]),
    ["BasketStockfill", d?.basketProgram],
  ];
  const props: [string, string][] = [
    ["Fee", "0% router fee. You pay only the pools’ own fees and gas."],
    ["Your limit", "Sell exactly: a minimum on what you receive. Buy exactly: a maximum on what you pay, and whatever is left of it comes straight back in the same transaction."],
    ["Approvals", "One signature instead of an approval transaction for tokens that support it (EIP-2612 or Permit2). Otherwise the app asks for the exact amount, never unlimited."],
    ["Custody", "The router holds nothing between swaps. Every leg fills in full or the whole swap reverts."],
    ["Control", "Router and quoter: no owner, no admin keys, no pause, no upgrade path. Vault settings: every change waits 48 hours in TimelockStockfill."],
  ];
  return (
    <section id="contracts" className="section wrap">
      <div className="section-head">
        <span className="label">Contracts</span>
        <h2>
          Small, immutable, <em>empty.</em>
        </h2>
        <p>Every contract carries the Stockfill name and is verified. Read them, don’t trust them.</p>
      </div>
      <div className="twocol">
        <div className="panel">
          <dl className="kv">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono">
                  {v ? (
                    <a href={addressUrl(v)} target="_blank" rel="noopener">
                      {v.slice(0, 8)}…{v.slice(-6)}
                    </a>
                  ) : (
                    <span className="muted">Not deployed yet</span>
                  )}
                </dd>
              </div>
            ))}
            <div>
              <dt>Venues</dt>
              <dd>Uniswap v3 (canonical factory) and Uniswap v4 (PoolManager)</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>Robinhood Chain · 4663</dd>
            </div>
          </dl>
        </div>
        <div className="panel">
          <dl className="kv">
            {props.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <p className="disclose">
        The contracts have not been independently audited. They are tested against real Uniswap v3 and v4 code (splits,
        exact-output swaps through every mix of v3 and v4 hops, native ETH, permits, partial fills, reentrancy), and Vault
        caps start small. Pools on Robinhood Chain are thin next to a large exchange, so large trades move the price.
        Nothing here is investment advice.
      </p>
    </section>
  );
}

export function TokenSection() {
  const { symbol, address } = BRAND.token;
  return (
    <section id="token" className="section wrap">
      <div className="section-head">
        <span className="label">Token</span>
        <h2>
          <em>${symbol}</em>
        </h2>
        <p>
          The {BRAND.name} token. 30% of the fees the Vaults earn buy back and burn ${symbol}. Swapping never touches it and
          the router charges no fee.
        </p>
      </div>
      <div className="twocol">
        <div className="token-card">
          <span className="label">Contract address</span>
          <h3>${symbol}</h3>
          <CopyCA variant="dark" />
          <div className="bars" aria-hidden="true">
            {[14, 20, 26, 32, 44].map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </div>
        </div>
        <div className="panel">
          <dl className="kv">
            <div>
              <dt>Ticker</dt>
              <dd className="mono">${symbol}</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>Robinhood Chain</dd>
            </div>
            <div>
              <dt>Official address</dt>
              <dd className="mono">{address || "Not launched"}</dd>
            </div>
            <div>
              <dt>Heads up</dt>
              <dd>Copycat tokens appear within minutes of any launch. Only the address on this page is ours. If it isn’t here, it isn’t us.</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

export function FAQ() {
  const qa: [string, string][] = [
    ["What does Stockfill do?", "It finds the best price for a swap across every Uniswap v3 and v4 pool on Robinhood Chain and fills it in one transaction, split across the pools that pay most."],
    ["Sell exactly or buy exactly?", "Type in the top field to sell an exact amount; you get at least the minimum shown. Type in the bottom field to buy an exact amount, say exactly 2 NVDA; you pay at most the maximum shown and the rest is refunded in the same transaction."],
    ["Why sign instead of approve?", "Many tokens let you authorise one swap with a signature (EIP-2612 or Uniswap’s Permit2). That replaces a separate approval transaction, and the signature only covers this swap’s amount, for a few minutes."],
    ["Is the price guaranteed?", "Your limit is. The router checks the total and reverts if you would get less than the minimum, or pay more than the maximum. You can do better than the quote, never worse than your limit."],
    ["What does it cost?", "0% router fee. You pay the pools’ own fees, which are in the quote, and gas."],
    ["What are Vaults?", `Deposit USDG into a Vault for one stock and earn its trading fees: 70% compounds for Vault holders and 30% buys back and burns $${BRAND.token.symbol}. Vault shares can back a Credit Line on the Borrow page.`],
    ["Which stocks?", "Official Robinhood Stock Tokens with a live pool on Robinhood Chain, priced in USDG. New ones are added as their pools launch."],
  ];
  return (
    <section id="faq" className="section wrap">
      <div className="section-head">
        <span className="label">FAQ</span>
        <h2>Questions</h2>
        <p>Short answers. The contracts are the long one.</p>
      </div>
      <div className="faq">
        {qa.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <p className="foot-big">{BRAND.name}</p>
        <div className="foot-row">
          <span>{BRAND.tagline}</span>
          <span className="foot-links">
            {BRAND.x && (
              <a href={BRAND.x} target="_blank" rel="noopener">
                X
              </a>
            )}
            {BRAND.telegram && (
              <a href={BRAND.telegram} target="_blank" rel="noopener">
                Telegram
              </a>
            )}
            <a href="/#markets">Markets</a>
            <a href="/vaults/">Vaults</a>
            <a href="/#contracts">Contracts</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
