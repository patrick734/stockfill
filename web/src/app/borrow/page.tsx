import "@/vaults/vaults.css";
import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Sections";
import { BorrowDeskList } from "@/vaults/components/BorrowDeskList";

export const metadata: Metadata = {
  title: `Borrow · ${BRAND.name}`,
  description: "Credit Lines: lend USDG, or pledge Stockfill Vault shares and borrow USDG against them at the Chainlink price.",
};

export default function BorrowPage() {
  return (
    <>
      <Header />
      <main className="wrap vx">
        <div className="vx-hero">
          <div className="pills">
            <span className="pill">Credit Lines · isolated per Vault</span>
          </div>
          <h1>
            Borrow <em>against your shares.</em>
          </h1>
          <p className="lede">
            Each Credit Line is an isolated market: USDG lenders on one side, holders of one Vault&apos;s shares on the other.
            Collateral is valued at Chainlink&apos;s price, never the pool&apos;s. Borrowing and liquidation need a fresh price;
            repaying is always open.
          </p>
        </div>
        <section className="section vx-tight">
          <BorrowDeskList />
        </section>
      </main>
      <Footer />
    </>
  );
}
