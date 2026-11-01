"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="mx-auto max-w-[1600px] px-4 py-24 sm:px-6 lg:px-10">
      <h1 className="poster-title text-[length:var(--text-display-md)] font-black">This page failed to load.</h1>
      <p className="mt-4 max-w-[56ch] text-ivory-2">Something went wrong while rendering. Try again; if it keeps happening, check that the SLOT1 API is running.</p>
      <button type="button" className="btn btn-primary mt-8" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
