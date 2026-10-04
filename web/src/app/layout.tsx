import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { BRAND } from "@/lib/brand";
import { Providers } from "./providers";
import "./globals.css";

// Absolute base for link previews: NEXT_PUBLIC_SITE_URL, else the Vercel production URL.
const SITE =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
const TITLE = `${BRAND.name}: best execution for Robinhood Stock Tokens`;
const DESCRIPTION =
  "Sell an exact amount or buy an exact amount of any Robinhood Stock Token, split across every Uniswap v3 and v4 pool on Robinhood Chain for the best price. 0% router fee, one transaction.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  icons: { icon: "/icon.svg" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: BRAND.name, images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f6" },
    { media: "(prefers-color-scheme: dark)", color: "#101113" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="backdrop" aria-hidden="true">
          <i className="b1" />
          <i className="b2" />
          <i className="b3" />
        </div>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
