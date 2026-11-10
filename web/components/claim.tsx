"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

/// The claim is typed once and read twice: by the headline, and by the lens inside the shooting
/// star, which magnifies whatever is underneath it. A shared count is what keeps the magnified copy
/// showing exactly the letters the headline is currently showing.

export const CLAIM_SEGMENTS = [
  { text: "A person and an agent,", className: "text-text" },
  { text: " one ledger,", className: "text-muted" },
  { text: " in $WIF.", className: "text-accent" },
];

const TOTAL = CLAIM_SEGMENTS.reduce((n, segment) => n + segment.text.length, 0);
const ClaimContext = createContext(0);

export function ClaimProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(TOTAL);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let typed = 0;
    setCount(0);

    const step = () => {
      if (cancelled) return;
      typed += 1;
      setCount(typed);
      if (typed < TOTAL) {
        /// Uneven delay: a steady drum reads as a machine printing, not as someone typing.
        timer = setTimeout(step, 34 + Math.random() * 42);
      } else {
        timer = setTimeout(() => {
          typed = 0;
          setCount(0);
          timer = setTimeout(step, 500);
        }, 10_000);
      }
    };

    timer = setTimeout(step, 260);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return <ClaimContext.Provider value={count}>{children}</ClaimContext.Provider>;
}

export function ClaimText() {
  const count = useContext(ClaimContext);
  let offset = 0;

  return (
    <>
      {CLAIM_SEGMENTS.map((segment) => {
        const start = offset;
        offset += segment.text.length;
        const shown = Math.max(0, Math.min(count - start, segment.text.length));
        const active = count >= start && count < start + segment.text.length;
        return (
          <span key={segment.text} className={segment.className} aria-hidden="true">
            {segment.text.slice(0, shown)}
            {active ? <span className="tw-cursor" /> : null}
          </span>
        );
      })}
    </>
  );
}
