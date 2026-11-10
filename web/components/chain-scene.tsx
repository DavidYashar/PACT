"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/// A conveyor along a hill. Each block is a flat rectangle, not a cube: it scales with its distance
/// from the peak, so the top of the hill is the nearest point without any 3D. Every 10s the run
/// advances one slot and the block crossing the peak is confirmed. Each block carries the bits that
/// link it to the block behind it, so the link travels with the block.
///
/// The motion is driven here, in one requestAnimationFrame loop, rather than by CSS transitions on
/// each block. A link's two ends belong to two different blocks, and CSS cannot keep two independently
/// transitioned elements aligned: measured during a tick, the ends drifted up to 80px apart. Writing
/// the block transform and the link transform from the same interpolated numbers in the same frame
/// makes attachment exact by construction, at rest and in motion.
///
/// This is a simulation of the chain, not a read of it: the hashes are random and the blocks are
/// not jobs. The readout says so, and the real numbers live in the band below.

const BLOCK = 84;
const TICK_MS = 10_000;
const SEED = 21;

type Pose = { x: number; y: number; s: number };

export function ChainScene() {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [active, setActive] = useState<number | null>(null);
  const [{ tick, blocks }, setState] = useState(() => ({
    tick: 0,
    blocks: Array.from({ length: SEED }, (_, i) => ({ key: i + 1, born: i - (SEED - 1) })),
    nextKey: SEED + 1,
  }));

  const blockEls = useRef(new Map<number, HTMLDivElement>());
  const shown = useRef(new Map<number, Pose>());
  const targets = useRef(new Map<number, Pose & { lag: number; entry: Pose }>());
  const cardSize = useRef(BLOCK);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const count = width < 640 ? 5 : width < 1100 ? 7 : 11;
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    /// A confirmation is a state change, but the conveyor is motion. Freeze it for anyone who asked
    /// the browser for less moving.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setState((s) => {
        const next = s.tick + 1;
        const kept = s.blocks.filter((b) => next - b.born <= countRef.current + 2);
        return { tick: next, blocks: [...kept, { key: s.nextKey, born: next }], nextKey: s.nextKey + 1 };
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const peak = (count - 1) / 2;
  const size = width < 640 ? 64 : BLOCK;
  cardSize.current = size;
  /// Wider than the viewport, so a block enters and leaves off screen instead of popping in beside
  /// its neighbour.
  const span = Math.max(width + size * 1.2, 0);
  const peakH = width < 640 ? 92 : 150;

  const geo = (slot: number): Pose => {
    const t = slot / (count - 1);
    const curve = Math.max(0, 1 - Math.pow(2 * t - 1, 2));
    return {
      x: (t - 0.5) * span,
      y: peakH * 0.35 - peakH * curve,
      /// Distance from the viewer is expressed as size: the peak block is the largest.
      s: 0.7 + 0.3 * curve,
    };
  };

  const visible = blocks
    .map((b) => ({ ...b, slot: tick - b.born }))
    .filter((b) => b.slot >= 0 && b.slot <= count)
    .sort((a, b) => b.slot - a.slot);

  /// The targets for the next frame, written during render so the loop never runs a frame behind.
  const next = new Map<number, Pose & { lag: number; entry: Pose }>();
  for (const block of visible) {
    next.set(block.key, { ...geo(block.slot), lag: Math.abs(block.slot - peak), entry: geo(-1) });
  }
  targets.current = next;
  for (const key of [...shown.current.keys()]) if (!next.has(key)) shown.current.delete(key);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;

      /// Two passes: advance every pose first, then write. A single pass would let a link read its
      /// neighbour's pose from the previous frame, which is a visible one-frame lag at 60fps.
      for (const [key, target] of targets.current) {
        let pose = shown.current.get(key);
        if (!pose) {
          /// A block that has just been born starts one slot behind, so it slides in.
          pose = { ...target.entry };
          shown.current.set(key, pose);
        }

        /// A per-block time constant keeps the cascading feel the CSS delays used to give.
        const ease = reduce ? 1 : 1 - Math.exp(-dt / (190 + target.lag * 40));
        pose.x += (target.x - pose.x) * ease;
        pose.y += (target.y - pose.y) * ease;
        pose.s += (target.s - pose.s) * ease;
      }

      for (const [key, pose] of shown.current) {
        const el = blockEls.current.get(key);
        if (!el) continue;
        el.style.transform = `translate3d(${pose.x}px, ${pose.y}px, 0)`;
        el.style.setProperty("--s", pose.s.toFixed(4));

        /// The link is drawn from the same two poses the blocks were just placed with: the centre of
        /// the block behind's right edge to the centre of this block's left edge.
        const link = el.querySelector<HTMLElement>(".clink");
        const behind = shown.current.get(key + 1);
        if (!link) continue;

        /// No block behind yet means nothing to connect to: the leftmost block has a link element for
        /// the layout, but it stays hidden until its neighbour exists. Otherwise a run of bits hangs
        /// off the left edge before the chain starts.
        if (!behind) {
          link.style.opacity = "0";
          continue;
        }

        const halfHere = (size * pose.s) / 2;
        const halfBehind = (size * behind.s) / 2;
        const dx = pose.x - behind.x;
        const dy = pose.y - behind.y;
        const run = Math.max(0, dx - halfHere - halfBehind);
        const length = Math.hypot(run, dy);
        const angle = (Math.atan2(dy, run) * 180) / Math.PI;

        link.style.transform = `translate3d(${-dx + halfBehind}px, ${-dy}px, 0) rotate(${angle}deg)`;
        link.style.width = `${length}px`;
        link.style.opacity = "1";
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  const linkBits = (key: number, slot: number) => {
    /// The bit count follows the resting gap, so the children do not churn every frame.
    const here = geo(slot);
    const behind = geo(slot - 1);
    const halfHere = (size * here.s) / 2;
    const halfBehind = (size * behind.s) / 2;
    const run = Math.max(0, here.x - behind.x - halfHere - halfBehind);
    const length = Math.hypot(run, here.y - behind.y);
    const bitCount = Math.max(2, Math.min(24, Math.floor(length / 10)));
    return bits(key, tick, bitCount);
  };

  const activeBlock = blocks.find((b) => b.key === active);
  const activeSlot = activeBlock ? tick - activeBlock.born : null;
  const readout =
    activeBlock && activeSlot !== null
      ? `block ${activeBlock.key} · ${activeSlot > peak ? "confirmed" : "pending"}`
      : `simulation · a block confirms every ${TICK_MS / 1000}s`;

  return (
    <div className="w-full">
      <div ref={wrap} className="cband">
        {visible.map((block) => {
          const here = geo(block.slot);
          const behind = geo(block.slot - 1);
          const confirmed = block.slot > peak;
          const halfHere = (size * here.s) / 2;
          const halfBehind = (size * behind.s) / 2;
          const length = Math.hypot(Math.max(0, here.x - behind.x - halfHere - halfBehind), here.y - behind.y);

          return (
            <div
              key={block.key}
              className="cblock"
              data-confirmed={confirmed}
              data-key={block.key}
              ref={(el) => {
                if (el) blockEls.current.set(block.key, el);
                else blockEls.current.delete(block.key);
              }}
              style={
                {
                  "--x": `${here.x}px`,
                  "--y": `${here.y}px`,
                  "--s": here.s,
                } as CSSProperties
              }
              onMouseEnter={() => setActive(block.key)}
              onMouseLeave={() => setActive((v) => (v === block.key ? null : v))}
            >
              <div className="ccard">
                <Hash seed={block.key} />
              </div>

              {/* The link to the block behind. Its transform and width are written by the animation
                  loop every frame; these are the resting values so the first paint is not a jump. */}
              <span className="clink" style={{ width: `${length}px` }}>
                <span className="cbits">
                  {linkBits(block.key, block.slot).map((bit, index) => (
                    <span key={index}>{bit}</span>
                  ))}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 pt-2">
        <span className="mono truncate text-[9px] uppercase tracking-[0.1em] text-muted">{readout}</span>
        <span className="mono hidden shrink-0 items-center gap-4 text-[9px] uppercase tracking-[0.1em] text-muted sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-[1px] bg-accent" aria-hidden="true" />
            confirmed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-[1px] border border-accent/40" aria-hidden="true" />
            pending
          </span>
        </span>
      </div>
    </div>
  );
}

/// One bit per character, drawn fresh on every confirmation, as many as the link needs. Seeded from
/// a string hash (xmur3), not a running PRNG: neighbouring seeds in a PRNG stay correlated, which is
/// how every link ended up reading `0 0 0 0`.
function bits(seed: number, tick: number, count: number): string[] {
  const key = `${seed}:${tick}`;
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h = (h ^ (h >>> 16)) >>> 0;
    out.push((h & 1) === 1 ? "1" : "0");
  }
  return out;
}

/// The block's contents: hash lines that keep arriving, the oldest scrolling out the top. Same
/// shape in every block, different values.
function Hash({ seed }: { seed: number }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const line = () => {
      let out = "0x";
      for (let i = 0; i < 8; i += 1) out += Math.floor(Math.random() * 16).toString(16);
      return out;
    };

    const push = () => {
      const rows = (el.textContent ?? "").split("\n").filter(Boolean).concat(line()).slice(-4);
      el.textContent = rows.join("\n");
    };

    push();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const id = window.setInterval(push, 700 + (seed % 6) * 150);
    return () => window.clearInterval(id);
  }, [seed]);

  return <pre ref={ref} className="chash" aria-hidden="true" />;
}
