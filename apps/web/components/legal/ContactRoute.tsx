import Link from "next/link";
import type { LegalConfig } from "@/lib/legal";

/** "the contact form (or email …)" for a given topic, always ending in a working route. */
export function ContactRoute({ cfg, topic }: { cfg: LegalConfig; topic: "privacy" | "copyright" | "business" | "support" | "general" }) {
  return (
    <>
      the <Link href={`/contact?topic=${topic}`}>contact form</Link>
      {cfg.email ? (
        <>
          {" "}
          or email <a href={`mailto:${cfg.email}`}>{cfg.email}</a>
        </>
      ) : null}
    </>
  );
}
