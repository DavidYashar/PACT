"use client";

import { useEffect, useState } from "react";
import { countdown } from "@/lib/format";
import { CountdownRing } from "@/components/ui";

/// The clock that decides a job.
///
/// The ring only claims a proportion when the whole window is known. `deliveryDeadline` and
/// `bidDeadline` are absolute, and the contract never stores when a job was posted or a bid
/// accepted, so for those states the ring shows the time left and turns, without inventing an
/// arc. Once a job is delivered the window is exact (`autoReleaseAt − autoReleaseDelay`), so the
/// arc is real and it empties.
export function DeadlineRing({
  target,
  from,
  label,
  size,
}: {
  target: bigint | number;
  from?: bigint | number;
  label: string;
  size?: number;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const end = Number(target);
  const start = from === undefined ? undefined : Number(from);
  const left = now === null ? undefined : end - now;

  const known = start !== undefined && Number.isFinite(start) && end - start > 0;
  const progress = known && left !== undefined ? left / (end - start) : 1;
  const state = left !== undefined && left <= 0 ? "late" : "running";

  return (
    <CountdownRing
      progress={state === "late" ? 0 : progress}
      label={label}
      value={countdown(target)}
      state={state}
      size={size}
      arc={known}
    />
  );
}
