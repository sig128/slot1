/**
 * SLOT1 station ident. "SLOT" in ivory; the "1" sits in a sunset-gradient slot like a
 * channel-number bug. Set in Passion One Black (OFL) until a licensed Pricedown logo replaces it; see docs/ASSET_MANIFEST.md.
 */
export function Wordmark({ size = "md", reveal = false }: { size?: "sm" | "md" | "xl"; reveal?: boolean }) {
  const scale = size === "xl" ? "text-[clamp(4.5rem,13vw,10rem)]" : size === "sm" ? "text-[1.55rem]" : "text-[2rem]";
  return (
    <span
      className={`${scale} ${reveal ? "wordmark-reveal" : ""} inline-flex items-stretch font-poster font-black uppercase leading-none tracking-[0.005em] select-none`}
      aria-label="SLOT1"
      role="img"
    >
      <span className="wm-slot inline-block pr-[0.06em]">SLOT</span>
      <span
        aria-hidden
        className="relative inline-flex items-center overflow-hidden rounded-[0.08em] px-[0.14em]"
        style={{ background: "linear-gradient(160deg, #FF4F87 0%, #FF7A7C 48%, #FFAD72 100%)" }}
      >
        <span className="wm-one inline-block text-graphite">1</span>
      </span>
    </span>
  );
}
