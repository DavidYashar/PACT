"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ESCROW_ADDRESS, pactAbi, type Job } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { addressUrl } from "@/lib/chain";
import { useAllJobs, useClaimable, useWifBalance } from "@/lib/hooks";
import { useUnrecorded } from "@/lib/names";
import { useJobContent } from "@/lib/use-content";
import { JobCard } from "@/components/job-card";
import { Badge, Button, Empty, Panel, Spinner } from "@/components/ui";

const ZERO = "0x0000000000000000000000000000000000000000";

/// Shared by the public profile and the connected user's own account page.
export function ProfileView({ address, isSelf }: { address: `0x${string}`; isSelf: boolean }) {
  const { jobs, isLoading } = useAllJobs();
  const { contents } = useJobContent();
  const { data: balance } = useWifBalance(address);
  const { data: claimable } = useClaimable(address);
  const { data: unrecorded } = useUnrecorded(address);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const lower = address.toLowerCase();

  const mine = useMemo(
    () =>
      jobs.filter(
        ({ job }) =>
          job.employer.toLowerCase() === lower ||
          (job.worker.toLowerCase() === lower && job.worker !== ZERO),
      ),
    [jobs, lower],
  );

  const asWorker = mine.filter(({ job }) => job.worker.toLowerCase() === lower);
  const asEmployer = mine.filter(({ job }) => job.employer.toLowerCase() === lower);

  const settledAsWorker = asWorker.filter(({ job }) => job.state === 5);
  const settledAsEmployer = asEmployer.filter(({ job }) => job.state === 5);

  /// Net income: the price minus the 5% platform cut. The bond return is not income,
  /// it is the worker's own collateral coming back.
  const netEarned = settledAsWorker.reduce((sum, { job }) => sum + job.price - job.price / 20n, 0n);
  const spent = settledAsEmployer.reduce((sum, { job }) => sum + job.price, 0n);

  const inProgress = mine.filter(({ job }) => job.state === 2 || job.state === 3).length;
  const openTickets = mine.filter(({ job }) => job.state === 4).length;
  const openPostings = asEmployer.filter(({ job }) => job.state === 1).length;

  const claimValue = claimable as bigint | undefined;
  const canClaim = isSelf && claimValue !== undefined && claimValue > 0n;

  const active = mine.filter(({ job }) => job.state === 1 || job.state === 2 || job.state === 3 || job.state === 4);
  const history = mine.filter(({ job }) => job.state === 5 || job.state === 6);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">
            {isSelf ? "your account" : "profile"}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="display text-[30px] leading-none text-text">{shortAddress(address)}</h1>
            {isSelf ? <Badge tone="accent">you</Badge> : null}
            <a
              href={addressUrl(address)}
              target="_blank"
              rel="noreferrer"
              className="mono text-[10px] text-muted hover:text-accent"
            >
              explorer ↗
            </a>
          </div>
        </div>

        {canClaim ? (
          <div className="flex flex-col items-end gap-2">
            <Button
              disabled={isPending || confirming || Number(unrecorded ?? 0) > 0}
              onClick={() => writeContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "claim" })}
            >
              {isPending || confirming
                ? "claiming…"
                : Number(unrecorded ?? 0) > 0
                  ? "record first"
                  : `claim ${formatWif(claimValue)} WIF`}
            </Button>
            <span className="mono text-[10px] text-muted">
              {Number(unrecorded ?? 0) > 0
                ? "record your settled work above to unlock this"
                : formatUsd(claimValue)}
            </span>
          </div>
        ) : null}
      </div>

      {isSuccess ? (
        <div className="mono mt-4 border border-accent/30 bg-accent/[0.05] p-3 text-[10px] text-accent">
          claimed. the balance above updates once the next read lands.
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
          {error.message.split("\n")[0]}
          <button onClick={reset} className="ml-2 underline">
            dismiss
          </button>
        </div>
      ) : null}

      <Panel className="mt-6">
        <div className="grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-4">
          <Mini label="earned (net)" value={formatWif(netEarned, { compact: true })} sub={formatUsd(netEarned)} accent />
          <Mini label="spent" value={formatWif(spent, { compact: true })} sub={`${settledAsEmployer.length} settled`} />
          <Mini label="jobs done" value={settledAsWorker.length} sub={`${inProgress} in progress`} />
          <Mini label="jobs posted" value={settledAsEmployer.length} sub={`${openPostings} open`} />
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-3">
          <Row label="WIF balance" value={formatWif(balance as bigint | undefined)} />
          <Row
            label="unclaimed"
            value={formatWif(claimValue)}
            highlight={claimValue !== undefined && claimValue > 0n}
          />
          <Row label="open tickets" value={String(openTickets)} highlight={openTickets > 0} />
        </div>
      </Panel>

      {isLoading ? (
        <div className="mt-8 border border-line px-6 py-16 text-center">
          <Spinner label="reading the chain" />
        </div>
      ) : mine.length === 0 ? (
        <div className="mt-8">
          <Empty>
            nothing here yet.{" "}
            <Link href="/jobs" className="text-accent hover:underline">
              browse jobs
            </Link>
            .
          </Empty>
        </div>
      ) : (
        <>
          <section className="mt-10">
            <h2 className="mono mb-4 text-[11px] uppercase tracking-[0.18em] text-muted">
              active · {active.length}
            </h2>
            {active.length === 0 ? (
              <p className="text-[13px] text-muted">nothing running.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {active.map(({ id, job }) => (
                  <RoleCard key={id} id={id} job={job} lower={lower} content={contents[id]} />
                ))}
              </div>
            )}
          </section>

          <section className="mt-10">
            <h2 className="mono mb-4 text-[11px] uppercase tracking-[0.18em] text-muted">
              history · {history.length}
            </h2>
            {history.length === 0 ? (
              <p className="text-[13px] text-muted">nothing settled yet.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {history
                  .sort((a, b) => b.id - a.id)
                  .map(({ id, job }) => (
                    <JobCard key={id} id={id} job={job} title={contents[id]?.title} category={contents[id]?.category} />
                  ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RoleCard({
  id,
  job,
  lower,
  content,
}: {
  id: number;
  job: Job;
  lower: string;
  content?: { title: string; category: string };
}) {
  const role = job.employer.toLowerCase() === lower ? "employer" : "worker";
  return (
    <Link
      href={`/job/${id}`}
      className="group flex flex-col gap-3 border border-line bg-panel p-4 transition-colors hover:border-line-2 hover:bg-panel-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mono text-[9px] uppercase tracking-[0.16em] text-muted">
            #{id} · {role}
          </div>
          <div className="mt-1 truncate text-[13px] text-text group-hover:text-accent">
            {content?.title ?? "terms not published"}
          </div>
        </div>
        <Badge tone={job.state === 4 ? "danger" : job.state === 3 ? "warn" : "accent"}>
          {job.state === 1 ? "open" : job.state === 2 ? "in progress" : job.state === 3 ? "delivered" : "disputed"}
        </Badge>
      </div>
      <div className="mono flex items-center justify-between text-[10px]">
        <span className="text-accent">{formatWif(job.price || job.budget)} WIF</span>
        <span className="text-muted">{formatUsd(job.price || job.budget)}</span>
      </div>
    </Link>
  );
}

function Mini({
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

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between bg-panel px-4 py-3">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className={`mono text-[11px] ${highlight ? "text-accent" : "text-text"}`}>{value}</span>
    </div>
  );
}
