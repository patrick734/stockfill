import "@/vaults/vaults.css";
import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Sections";
import { MarketChip } from "@/vaults/components/MarketChip";
import { VaultList } from "@/vaults/components/VaultList";
import { FeeSplit } from "@/vaults/components/FeeSplit";
import { HomeStats } from "@/vaults/components/HomeStats";
import { BasketStatus } from "@/vaults/components/BasketStatus";
import { BorrowTeaser } from "@/vaults/components/BorrowTeaser";
import { SectionHead } from "@/vaults/components/ui";
import { FILL } from "@/vaults/lib/brand";

export const metadata: Metadata = {
  title: `Vaults · ${BRAND.name}`,
  description: "Deposit USDG into a Stockfill Vault: liquidity for one Robinhood Stock Token around the Chainlink price. 70% of trading fees compounds for Vault holders, 30% buys back and burns $FILL.",
};

const STEPS = [
  {
    n: "01",
    title: "Deposit USDG",
    body: "You receive Vault shares that track your slice of everything the Vault holds. New deposits wait for the next rebalance, then go to work.",
  },
  {
    n: "02",
    title: "Liquidity at the Chainlink price",
    body: "A keeper holds a tight Uniswap v4 range around Chainlink's price and moves it as the stock moves. Every trade through the range pays a fee.",
  },
  {
    n: "03",
    title: "Fees split 70 / 30",
    body: `70% compounds into the Vault, so each share is worth more. 30% buys back ${FILL} and burns it. The 30% ceiling is in the contract.`,
  },
];

export default function VaultsPage() {
  return (
    <>
      <Header />
      <main className="wrap vx">
        <div className="vx-hero">
          <div className="pills">
            <MarketChip />
            <span className="pill">One Vault per Stock Token</span>
          </div>
          <h1>
            Earn the fees <em>on every trade.</em>
          </h1>
          <p className="lede">
            Each Vault provides liquidity for one Robinhood Stock Token around Chainlink&apos;s price, collects a fee on every
            trade through its range and compounds 70% of it for Vault holders. Deposits open while NYSE is open and prices
            are fresh; redeeming in kind is open any time.
          </p>
          <HomeStats />
        </div>

        <section className="section" id="vaults">
          <SectionHead label="Vaults" title={<>Pick a stock, <em>earn its fees.</em></>}>
            Held value against each Vault&apos;s cap, the recent yield rate and whether deposits are open right now.
          </SectionHead>
          <VaultList />
        </section>

        <section className="section">
          <SectionHead label="How it works" title={<>Deposit once, <em>it compounds.</em></>}>
            Vault shares grow as fees come in. Withdraw in USDG while the price is fresh, or redeem in kind at any time.
          </SectionHead>
          <ol className="steps">
            {STEPS.map((s) => (
              <li key={s.n}>
                <span className="step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <FeeSplit />
        <BasketStatus />
        <BorrowTeaser />
      </main>
      <Footer />
    </>
  );
}
