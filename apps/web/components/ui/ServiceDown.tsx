export function ServiceDown({ message, requirement }: { message: string; requirement: string | null }) {
  return (
    <section className="mx-auto max-w-[1600px] px-4 py-24 sm:px-6 lg:px-10">
      <h1 className="poster-title text-[length:var(--text-display-md)] font-black">Can’t reach SLOT1 right now.</h1>
      <p className="mt-4 max-w-[60ch] text-ivory-2">{message}.</p>
      {requirement && <p className="mt-2 text-sm text-ivory-3">{requirement}</p>}
    </section>
  );
}
