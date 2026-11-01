import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/barlow-condensed/900.css";
import "@fontsource-variable/inter";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/brand/SiteHeader";

export const metadata: Metadata = {
  title: { default: "SLOT1", template: "%s — SLOT1" },
  description: "Watch GTA broadcasts on Twitch with an evidence-backed log of what SLOT1 actually saw.",
};

export const viewport: Viewport = { themeColor: "#101014", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a href="#main" className="sr-only z-50 bg-ivory px-3 py-2 text-graphite focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <footer className="border-t hairline">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-[0.82rem] text-ivory-3 sm:px-6 lg:px-10">
            <span>SLOT1 is independent and not affiliated with Rockstar Games, Take-Two, Sony or Twitch.</span>
            <Link href="/setup" className="hover:text-ivory">
              How SLOT1 works
            </Link>
            <Link href="/demo" className="hover:text-ivory">
              Design demo (fixtures)
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
