import { nonce } from "@/lib/server";
import { jsonLdString } from "@/lib/jsonld";

/**
 * Structured data for search engines (schema.org JSON-LD). It's a data block, not a script the
 * browser runs; the CSP nonce is added anyway so it never shows up as a blocked inline script.
 */
export async function JsonLd({ data }: { data: object | object[] }) {
  return <script type="application/ld+json" nonce={await nonce()} dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />;
}
