import type { Metadata } from "next";
import { connection } from "next/server";
import { ContactTopic } from "@slot1/contracts";
import { ContactForm } from "@/components/contact/ContactForm";

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions, privacy requests, copyright notices and business enquiries for SLOT1.",
  alternates: { canonical: "/contact" },
};

/** A public contact address, read at request time from SLOT1_CONTACT_EMAIL (optional). */
function contactEmail(): string | null {
  const v = (process.env.SLOT1_CONTACT_EMAIL ?? "").trim();
  return /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i.test(v) ? v : null;
}

export default async function ContactPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  await connection();
  const { topic } = await searchParams;
  const initialTopic = ContactTopic.safeParse(topic).success ? (topic as ContactTopic) : "general";
  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 pt-12 sm:px-6 lg:px-10">
      <h1 className="poster-title text-[length:var(--text-display-lg)] leading-[0.9]">Contact</h1>
      <p className="mt-5 max-w-[56ch] text-[1.05rem] text-ivory-2">
        Questions about SLOT1, requests about your data, copyright notices and business enquiries all come here, to the people who run SLOT1.
      </p>
      <ContactForm initialTopic={initialTopic} contactEmail={contactEmail()} />
    </div>
  );
}
