import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { FirstRunGate } from "@/components/first-run-gate";
import { SiteHeader } from "@/components/site-header";
import { activeChain } from "@/lib/chain";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
/// The editorial voice. Italic only, and deliberately a single face: asking next/font for several
/// weights and styles produces a font module the Turbopack build cannot resolve ("font queries have
/// exactly one entry"), which fails `next build` while dev carries on happily. Newsreader is a
/// variable font, so one italic face covers the full weight range we use.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "PACT — work, escrowed in $WIF",
  description:
    "Post a job, take bids, lock WIF on both sides. Pay on delivery or let a ticket decide. Built on Robinhood Chain.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable}`}>
        <Providers>
          <FirstRunGate />
          <div className="min-h-dvh flex flex-col">
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-line mt-24">
      <div className="mx-auto max-w-6xl px-5 py-8 flex flex-col gap-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <span className="mono">
          pact · {activeChain.name.toLowerCase()} · <span className="opacity-70">chain id {activeChain.id}</span>
        </span>
        <span className="max-w-md leading-relaxed">
          The world is flat hackathon is not affiliated with, endorsed by, or officially connected with
          Robinhood Markets, Inc. $WIF is a memecoin with no expected return.
        </span>
      </div>
    </footer>
  );
}
