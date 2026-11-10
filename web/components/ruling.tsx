"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { TypedLines } from "./typed-lines";

/// The two halves of the guarantee: what a ruling can and cannot do, and what the chain proves.
/// Both are structural claims, checkable in the ABI, so neither needs a number or a chart.
///
/// The section arrives in two pushes. Everything in the left column enters from off the left edge,
/// everything in the right column from off the right edge, on a spring, and only once the section
/// is actually on screen. The bottom pair enters the same way, each from its own side.

const GUARANTEES = [
  "No address parameter anywhere in the ruling path. Recipients are fixed when the job is created.",
  "The fine is capped at 10% of the worker's bond, and clamped to what the escrow actually holds.",
  "A resolver that is the employer or the worker of the job cannot rule on it.",
];

const PROVES = [
  "the money was in custody before work started",
  "the proof landed before the deadline",
  "no recipient could be redirected",
];

const DOES_NOT = ["whether the work is good", "who deserved to win the ticket", "that the ruling was right"];

export function Ruling() {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  const [cycle, setCycle] = useState(0);

  /// One clock for both columns: while the section is on screen, the cycle ticks every thirty
  /// seconds and every typed column restarts together.
  useEffect(() => {
    if (!shown) return;
    const id = window.setInterval(() => setCycle((c) => c + 1), 30_000);
    return () => window.clearInterval(id);
  }, [shown]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }

    /// Two thresholds, not one: the push fires when a quarter of the section is on screen, and the
    /// blocks re-arm only once the section is completely out of view. That way it replays on every
    /// arrival, from above or below, without flickering while the section is still partly visible.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.25) setShown(true);
          else if (entry.intersectionRatio === 0) setShown(false);
        }
      },
      { threshold: [0, 0.25] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /// Every animated block carries its own side and its place in the queue, so the two columns can
  /// leave together without arriving in lockstep.
  const part = (side: -1 | 1, index: number, delay = 0): CSSProperties =>
    ({ "--side": side, "--i": index, "--d": `${delay}ms` }) as CSSProperties;

  return (
    <section
      ref={ref}
      data-ruling="true"
      data-shown={shown ? "true" : "false"}
      className="overflow-hidden border-b border-line"
    >
      <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <div>
            <h2 className="section-title ruling-item text-text" style={part(-1, 0)}>
              A ruling cannot take the money.
            </h2>
            <p className="lead ruling-item mt-6 max-w-md text-muted" style={part(-1, 1)}>
              The resolver answers one question and sets one number. There is no address in the path, so
              there is nowhere to send funds except back to the two parties and the treasury.
            </p>
            <p
              className="mono ruling-item mt-8 text-[10px] uppercase tracking-[0.1em] text-muted"
              style={part(-1, 2)}
            >
              a wrong verdict is possible · taking the money is not
            </p>
          </div>

          <div>
            <div className="ruling-item border border-line bg-panel px-5 py-4" style={part(1, 0, 70)}>
              <p className="mono text-[12px] leading-relaxed text-text sm:text-[13px]">
                resolveDispute(jobId, ruling, fineBps)
              </p>
            </div>

            <ol className="mt-8 border-t border-line">
              {GUARANTEES.map((line, index) => (
                <li
                  key={line}
                  className="ruling-item flex gap-4 border-b border-line py-4"
                  style={part(1, index + 1, 70)}
                >
                  <span className="mono shrink-0 pt-0.5 text-[10px] tabular-nums text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[13px] leading-relaxed text-muted">{line}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="mt-16 grid gap-10 border-t border-line pt-12 sm:grid-cols-2 sm:gap-16">
          <div className="ruling-item" style={part(-1, 0, 220)}>
            <h3 className="mono text-[15px] uppercase tracking-[0.12em] text-text sm:text-[16px]">
              what the chain proves
            </h3>
            <TypedLines lines={PROVES} active={shown} cycle={cycle} tone="text" />
          </div>
          <div className="ruling-item" style={part(1, 0, 280)}>
            <h3 className="mono text-[15px] uppercase tracking-[0.12em] text-text sm:text-[16px]">
              what it does not
            </h3>
            <TypedLines lines={DOES_NOT} active={shown} cycle={cycle} tone="muted" />
          </div>
        </div>
      </div>
    </section>
  );
}
