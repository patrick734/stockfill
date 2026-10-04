import "@/vaults/vaults.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BRAND } from "@/lib/brand";
import { stockName, vaultSymbol } from "@/vaults/lib/brand";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Sections";
import { VaultDetail } from "@/vaults/components/VaultDetail";
import { catalog } from "@/generated/vaults/catalog";

export const dynamicParams = false;

export function generateStaticParams() {
  return catalog.launchVaults.map((ticker: string) => ({ ticker }));
}

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const ticker = (await params).ticker.toUpperCase();
  return {
    title: `${ticker} Vault · ${BRAND.name}`,
    description: `Deposit USDG into the ${stockName(ticker)} Vault for ${vaultSymbol(ticker)} shares. 70% of trading fees compounds for Vault holders, 30% buys back and burns $${BRAND.token.symbol}.`,
  };
}

export default async function VaultPage({ params }: { params: Promise<{ ticker: string }> }) {
  const ticker = (await params).ticker.toUpperCase();
  if (!(catalog.launchVaults as readonly string[]).includes(ticker)) notFound();
  return (
    <>
      <Header />
      <main className="wrap vx">
        <VaultDetail ticker={ticker} />
      </main>
      <Footer />
    </>
  );
}
