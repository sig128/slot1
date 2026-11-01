import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-[1600px] px-4 py-24 sm:px-6 lg:px-10">
      <h1 className="poster-title text-[length:var(--text-display-lg)] font-black leading-[0.88]">Off the map.</h1>
      <p className="mt-4 max-w-[56ch] text-ivory-2">That page doesn’t exist, or it belongs to a session you can’t see.</p>
      <Link href="/" className="btn btn-primary mt-8">
        Back to On Air
      </Link>
    </section>
  );
}
