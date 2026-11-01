import { EVIDENCE_CLASS_LABEL, type EvidenceClass } from "@slot1/contracts";

/** Small shape that encodes the evidence class (never color alone — the label is always nearby). */
export function EvidenceGlyph({ cls, className = "" }: { cls: EvidenceClass; className?: string }) {
  const common = `inline-block shrink-0 ${className}`;
  switch (cls) {
    case "visible_text":
      return <span aria-hidden className={`${common} h-2 w-2 bg-current`} />;
    case "visible":
      return <span aria-hidden className={`${common} h-2 w-2 border border-current`} />;
    case "inferred":
      return <span aria-hidden className={`${common} h-2 w-2 rotate-45 border border-apricot`} />;
    case "heard":
      return <span aria-hidden className={`${common} h-2 w-2 rounded-full bg-current`} />;
    case "measured":
      return <span aria-hidden className={`${common} h-[2px] w-2.5 bg-current opacity-70`} />;
    case "platform":
      return <span aria-hidden className={`${common} h-2 w-2 rounded-full border-[1.5px] border-coral`} />;
    case "correction":
      return <span aria-hidden className={`${common} h-2 w-2 border-[1.5px] border-apricot`} />;
  }
}

export function EvidenceClassLabel({ cls }: { cls: EvidenceClass }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <EvidenceGlyph cls={cls} />
      {EVIDENCE_CLASS_LABEL[cls]}
    </span>
  );
}
