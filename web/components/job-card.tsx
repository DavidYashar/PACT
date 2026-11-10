"use client";

import Link from "next/link";
import { STATE_LABEL, type Job } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { StateBadge } from "./ui";
import { Countdown } from "./countdown";
import { Party } from "./party";

/// A job on the board. Price is the loudest thing in the card, because price is what a worker
/// scans for; the clock is second, because the money depends on it.
export function JobCard({
  id,
  job,
  title,
  category,
}: {
  id: number;
  job: Job;
  title?: string;
  category?: string;
}) {
  const open = job.state === 1;
  const assigned = job.state === 2;
  const delivered = job.state === 3;
  const disputed = job.state === 4;

  const statusLabel = open
    ? "bids close"
    : assigned
      ? "deliver by"
      : delivered
        ? "auto-release"
        : disputed
          ? "frozen"
          : "paid to";

  const statusValue = open ? (
    <Countdown target={job.bidDeadline} />
  ) : assigned ? (
    <Countdown target={job.deliveryDeadline} />
  ) : delivered ? (
    <Countdown target={job.autoReleaseAt} />
  ) : disputed ? (
    <span className="text-danger">in dispute</span>
  ) : (
    shortAddress(job.worker)
  );

  return (
    <Link
      href={`/job/${id}`}
      className="panel-sheen group flex flex-col rounded-[16px] border border-line bg-panel transition-colors hover:border-line-2"
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <span className="mono text-[10px] uppercase tracking-[0.1em] text-muted">
          #{id}
          {category ? ` · ${category}` : ""}
        </span>
        <StateBadge state={job.state} label={STATE_LABEL[job.state] ?? "—"} />
      </div>

      <p className="mt-3 px-5 text-[16px] leading-snug text-text transition-colors group-hover:text-accent">
        {title ?? <span className="text-muted">terms not published</span>}
      </p>

      <div className="mt-3 flex min-w-0 items-center gap-2 px-5">
        <Party address={job.employer} />
        <span className="shrink-0 text-[10px] text-line-2" aria-hidden="true">
          →
        </span>
        <Party address={job.worker} />
      </div>

      <div className="mt-auto flex items-end justify-between gap-4 border-t border-line px-5 py-4">
        <div className="flex flex-col gap-1">
          <span className="mono text-[22px] leading-none tabular-nums text-text">
            {formatWif(job.state === 1 ? job.budget : job.price)}
          </span>
          <span className="mono text-[10px] text-muted">
            WIF · {formatUsd(job.state === 1 ? job.budget : job.price)}
          </span>
        </div>

        <div className="flex flex-col items-end gap-1 text-right">
          <span className="label">{statusLabel}</span>
          <span className="mono text-[11px] tabular-nums text-text">{statusValue}</span>
        </div>
      </div>
    </Link>
  );
}
