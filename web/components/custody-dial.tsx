import { formatWif } from "@/lib/format";

/// The custody dial. Four readouts sit at its corners, each with a leader rule pointing in at the
/// ring, so the object reads as an instrument with values on it rather than a circle with a number
/// in the middle. Every readout is a chain read or it says it has nothing to report.
export function CustodyDial({
  locked,
  employerSide,
  workerSide,
  inFlight,
  nextDeadline,
  total,
  open,
  disputed,
}: {
  locked: bigint;
  employerSide: bigint;
  workerSide: bigint;
  inFlight: number;
  nextDeadline: string | null;
  total: number;
  open: number;
  disputed: number;
}) {
  const custody = locked > 0n;

  return (
    <div className="mx-auto w-full max-w-[460px]">
      <div className="relative aspect-square">
        <div className="glow-soft pointer-events-none absolute inset-0" aria-hidden="true" />

        <svg viewBox="0 0 460 460" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <circle cx="230" cy="230" r="196" fill="none" stroke="var(--color-line)" strokeWidth="1" />
          {/* The ring turns only while money is locked. When custody is empty it is a still ring. */}
          <circle
            cx="230"
            cy="230"
            r="196"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1"
            strokeDasharray="2 10"
            opacity={custody ? 0.55 : 0.12}
            className={custody ? "origin-[230px_230px] animate-[spin_80s_linear_infinite]" : undefined}
          />
          <circle cx="230" cy="230" r="156" fill="none" stroke="var(--color-line)" strokeWidth="1" />
          <circle cx="230" cy="230" r="104" fill="none" stroke="var(--color-line-2)" strokeWidth="1" />
          {[0, 90, 180, 270].map((deg) => (
            <line
              key={deg}
              x1="230"
              y1="18"
              x2="230"
              y2="34"
              stroke="var(--color-line-2)"
              strokeWidth="1"
              transform={`rotate(${deg} 230 230)`}
            />
          ))}
        </svg>

        <Annotation side="left" place="top" label="employer side" value={`${formatWif(employerSide, { compact: true })} WIF`} live={employerSide > 0n} />
        <Annotation side="left" place="bottom" label="worker side" value={`${formatWif(workerSide, { compact: true })} WIF`} live={workerSide > 0n} />
        <Annotation side="right" place="top" label="next deadline" value={nextDeadline ?? "none running"} live={nextDeadline !== null} />
        <Annotation side="right" place="bottom" label="jobs in flight" value={inFlight === 0 ? "none" : String(inFlight)} live={inFlight > 0} />

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="mono text-[10px] uppercase tracking-[0.1em] text-muted">
            {custody ? "in custody" : "nothing locked"}
          </span>
          <span className="mono mt-2 text-[44px] leading-none tabular-nums text-text">
            {formatWif(locked, { compact: true })}
          </span>
          <span className="mono mt-2 text-[10px] uppercase tracking-[0.1em] text-muted">WIF escrowed now</span>
          <span className="mono mt-5 text-[9px] tabular-nums text-muted">
            {total} jobs · {open} open · {disputed} in dispute
          </span>
        </div>
      </div>

      {/* On a phone the corners have no room, so the same four values become a plain grid. */}
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:hidden">
        {[
          ["employer side", `${formatWif(employerSide, { compact: true })} WIF`],
          ["worker side", `${formatWif(workerSide, { compact: true })} WIF`],
          ["next deadline", nextDeadline ?? "none running"],
          ["jobs in flight", inFlight === 0 ? "none" : String(inFlight)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="mono text-[9px] uppercase tracking-[0.1em] text-muted">{label}</dt>
            <dd className="mono mt-1 text-[12px] tabular-nums text-text">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Annotation({
  side,
  place,
  label,
  value,
  live,
}: {
  side: "left" | "right";
  place: "top" | "bottom";
  label: string;
  value: string;
  live: boolean;
}) {
  return (
    <div
      className={`absolute hidden w-[92px] sm:block ${side === "left" ? "left-0" : "right-0"} ${
        place === "top" ? "top-[5%]" : "bottom-[5%]"
      } ${side === "right" ? "text-right" : "text-left"}`}
    >
      <span className="mono block text-[9px] uppercase tracking-[0.1em] text-muted">{label}</span>
      <span className={`mono mt-1 block text-[12px] tabular-nums ${live ? "text-text" : "text-muted"}`}>{value}</span>
      <span className={`mt-2 block h-px w-6 bg-line-2 ${side === "left" ? "ml-auto" : ""}`} aria-hidden="true" />
    </div>
  );
}
