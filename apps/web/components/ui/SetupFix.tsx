import type { CapabilityStatus } from "@slot1/contracts";

/**
 * Operators only: which server settings a feature is missing and the command that fixes it.
 * The API sends `setup` to operators and /admin sessions alone (apps/api/src/lib/setup-details.ts),
 * so for visitors and creators this renders nothing and they read the friendly line next to it.
 */
export function SetupFix({
  cap,
  className = "mt-1 block text-[0.8rem] text-ivory-3",
}: {
  cap: Pick<CapabilityStatus, "available" | "setup"> | null | undefined;
  className?: string;
}) {
  const setup = cap && !cap.available ? cap.setup : null;
  if (!setup) return null;
  return (
    <span className={className} data-testid="setup-fix">
      <strong className="font-semibold text-ivory-2">Operators only:</strong>
      {setup.missing.length > 0 && <> missing {setup.missing.join(", ")}.</>}
      {setup.settings ? (
        <>
          {" "}
          Set it in{" "}
          <a href="/admin#settings" className="underline hover:text-ivory">
            {setup.settings}
          </a>
          {setup.command && (
            <>
              , or run <code className="bg-graphite-800 px-1 text-ivory">{setup.command}</code> on the server
            </>
          )}
          .
        </>
      ) : setup.command ? (
        <>
          {" "}
          Run <code className="bg-graphite-800 px-1 text-ivory">{setup.command}</code> on the server.
        </>
      ) : (
        <> Set it in the server’s .env (see .env.example), then restart SLOT1.</>
      )}
    </span>
  );
}
