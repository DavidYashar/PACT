"use client";

import { useEffect, useState } from "react";
import { countdown } from "@/lib/format";

/// Renders nothing on the server so the ticking value never causes a hydration mismatch.
export function Countdown({
  target,
  className = "",
  urgent = false,
}: {
  target?: bigint | number;
  className?: string;
  urgent?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setText(countdown(target));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  const ended = text === "ended";

  return (
    <span className={`mono tabular-nums ${ended ? "text-muted" : urgent ? "text-warn" : ""} ${className}`}>
      {text ?? "—"}
    </span>
  );
}

/// Counts elapsed time upward, for "delivered 3h ago" style labels.
export function Since({ from }: { from: bigint | number }) {
  const [text, setText] = useState("—");

  useEffect(() => {
    const target = typeof from === "bigint" ? Number(from) : from;
    const tick = () => {
      const diff = Math.floor(Date.now() / 1000) - target;
      if (diff < 60) setText(`${diff}s ago`);
      else if (diff < 3600) setText(`${Math.floor(diff / 60)}m ago`);
      else if (diff < 86400) setText(`${Math.floor(diff / 3600)}h ago`);
      else setText(`${Math.floor(diff / 86400)}d ago`);
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [from]);

  return <span className="mono tabular-nums">{text}</span>;
}
