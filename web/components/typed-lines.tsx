"use client";

import { useEffect, useState } from "react";

/// Types a short list out line by line. The hook is `active`, which the section flips when it comes
/// into view and back when it leaves, so every arrival replays it. `cycle` is the shared beat: the
/// section bumps it every thirty seconds, and every column restarts on the same tick rather than
/// thirty seconds after it individually finished typing.
///
/// Un-typed lines keep a non-breaking space, so the block never changes height while it types.
export function TypedLines({
  lines,
  active,
  cycle,
  tone = "text",
}: {
  lines: string[];
  active: boolean;
  cycle: number;
  tone?: "text" | "muted";
}) {
  const total = lines.reduce((n, line) => n + line.length, 0);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active) {
      setCount(0);
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(total);
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
      if (typed < total) timer = setTimeout(step, 18 + Math.random() * 26);
    };

    /// A short beat so the block has finished sliding in before its text starts.
    timer = setTimeout(step, 520);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, total, cycle]);

  let offset = 0;
  return (
    <ul className="mt-5 flex flex-col gap-3">
      {lines.map((line) => {
        const start = offset;
        offset += line.length;
        const shown = Math.max(0, Math.min(count - start, line.length));
        const typing = count >= start && count < start + line.length;
        return (
          <li
            key={line}
            className={`text-[14px] leading-relaxed ${tone === "muted" ? "text-muted" : "text-text"}`}
          >
            {line.slice(0, shown) || "\u00A0"}
            {typing ? <span className="tw-cursor" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
