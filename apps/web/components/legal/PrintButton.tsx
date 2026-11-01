"use client";

/** Prints the page; the print stylesheet drops the site chrome and uses black on white. */
export function PrintButton() {
  return (
    <button type="button" className="btn btn-ghost btn-sm mt-6" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
