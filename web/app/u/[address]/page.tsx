"use client";

import { use } from "react";
import { useReadContract } from "wagmi";
import { ESCROW_ADDRESS, pactAbi } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { addressUrl } from "@/lib/chain";
import { useAllJobs, useWifBalance } from "@/lib/hooks";
import { useJobContent } from "@/lib/use-content";
import { JobCard } from "@/components/job-card";
import { Empty, Panel, Spinner } from "@/components/ui";
import { useProfile } from "@/lib/names";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = use(params);
  const address = raw as `0x${string}`;
  const { jobs, isLoading } = useAllJobs();
  const { contents } = useJobContent();
  const { data: profile } = useProfile(address);
  const { data: wif } = useWifBalance(address);
  const { data: claimable } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "claimable",
    args: [address],
  });

  const mine = jobs.filter(
    ({ job }) =>
      job.employer.toLowerCase() === raw.toLowerCase() ||
      (job.worker.toLowerCase() === raw.toLowerCase() && job.worker !== ZERO_ADDRESS),
  );

  const earned = profile?.earnedAsWorker;
  const posts = profile?.jobsPosted;
  const completed = profile?.jobsDone;
  const tickets = profile?.tickets;

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">profile</div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl tracking-[-0.01em]">{profile?.name ? `@${profile.name}` : shortAddress(raw)}</h1>
        <span className="mono text-[10px] text-muted">{raw}</span>
        <a
          href={addressUrl(raw)}
          target="_blank"
          rel="noreferrer"
          className="mono text-[10px] text-muted hover:text-accent"
        >
          explorer ↗
        </a>
      </div>

      <Panel className="mt-7">
        <div className="grid grid-cols-2 divide-x divide-line sm:grid-cols-4">
          <MiniStat label="earned" value={formatWif(earned, { compact: true })} sub={formatUsd(earned)} accent />
          <MiniStat label="jobs done" value={completed ?? "—"} sub="recorded as worker" />
          <MiniStat label="jobs posted" value={posts ?? "—"} sub="recorded settlements" />
          <MiniStat label="tickets" value={tickets ?? "—"} sub="recorded involvement" />
        </div>
        <div className="grid gap-px bg-line border-t border-line sm:grid-cols-2">
          <div className="flex items-center justify-between bg-panel px-4 py-3">
            <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">WIF balance</span>
            <span className="mono text-[11px]">{formatWif(wif)}</span>
          </div>
          <div className="flex items-center justify-between bg-panel px-4 py-3">
            <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">unclaimed</span>
            <span className={`mono text-[11px] ${claimable && claimable > 0n ? "text-accent" : ""}`}>
              {formatWif(claimable as bigint | undefined)}
            </span>
          </div>
        </div>
      </Panel>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        counters are written once per settled job priced at or above 100 WIF. a cheaper job still
        settles and still shows in the history below — it just adds nothing to the tally.
      </p>

      {isLoading ? (
        <div className="mt-8 border border-line px-6 py-16 text-center">
          <Spinner label="reading the chain" />
        </div>
      ) : mine.length === 0 ? (
        <div className="mt-8">
          <Empty>no jobs on this address yet.</Empty>
        </div>
      ) : (
        <section className="mt-10">
          <h2 className="mono mb-4 text-[11px] uppercase tracking-[0.18em] text-muted">history</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mine
              .sort((a, b) => b.id - a.id)
              .map(({ id, job }) => (
                <JobCard key={id} id={id} job={job} title={contents[id]?.title} category={contents[id]?.category} />
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-4">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className={`mono text-lg leading-none ${accent ? "text-accent" : "text-text"}`}>{value}</span>
      {sub ? <span className="mono text-[9px] text-muted">{sub}</span> : null}
    </div>
  );
}
