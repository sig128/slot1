import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/barlow-condensed/900.css";
import "@fontsource-variable/inter";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/brand/SiteHeader";
import { Beacon } from "@/components/analytics/Beacon";
import { rootMetadata, SITE } from "@/lib/site";

// Every page reads the deployment's public origin at request time (canonical URLs, share cards):
// the production image is built without .env, so nothing origin-dependent may be prerendered.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return rootMetadata();
}

export const viewport: Viewport = { themeColor: SITE.themeColor, colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a href="#main" className="sr-only z-50 bg-ivory px-3 py-2 text-graphite focus:not-sr-only focus:fixed focus:left-3 focus:top-3 print:hidden">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <footer className="border-t hairline print:hidden">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-[0.82rem] text-ivory-3 sm:px-6 lg:px-10">
            <span>SLOT1 is independent and not affiliated with Rockstar Games, Take-Two, Sony or Twitch.</span>
            <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
              <Link href="/setup" className="hover:text-ivory">
                How SLOT1 works
              </Link>
              <Link href="/demo" className="hover:text-ivory">
                Live demo
              </Link>
              <Link href="/privacy" className="hover:text-ivory">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-ivory">
                Terms
              </Link>
              <Link href="/contact" className="hover:text-ivory">
                Contact
              </Link>
            </nav>
          </div>
        </footer>
        <Beacon />
      </body>
    </html>
  );
}
