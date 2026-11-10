"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAllJobs } from "@/lib/hooks";
import { useJobContent } from "@/lib/use-content";
import { formatWif } from "@/lib/format";
import { activeChain } from "@/lib/chain";
import { JobCard } from "@/components/job-card";
import { ChainScene } from "@/components/chain-scene";
import { ClaimProvider, ClaimText } from "@/components/claim";
import { HashButton } from "@/components/hash-button";
import { JobFlow } from "@/components/job-flow";
import { Ruling } from "@/components/ruling";
import { ButtonLink, Empty, Spinner } from "@/components/ui";

/// The three states the contract actually has. Not a template's three steps: this is the order the
/// money moves in, and the tests in the escrow are named after them.
const MOVES = [
  {
    n: "01",
    stage: "lock",
    rule: "both sides pay in",
    body: "The employer escrows the full price. When a bid is accepted, half the price is pulled from the worker's wallet in the same transaction.",
  },
  {
    n: "02",
    stage: "deliver",
    rule: "proof before the clock",
    body: "The worker commits a proof hash before the deadline. If the employer stays silent, the money releases on its own when the silence window closes.",
  },
  {
    n: "03",
    stage: "rule",
    rule: "no address in the ruling path",
    body: "Either side can file a ticket for 10% of the price. The ruling moves money between the two parties and the treasury, never to the decider.",
  },
];

export default function Home() {
  const { jobs, isLoading } = useAllJobs();
  const { contents } = useJobContent();

  const stats = useMemo(() => {
    let locked = 0n;
    let settled = 0n;
    let open = 0;
    let disputed = 0;

    for (const { job } of jobs) {
      locked += job.employerEscrow + job.workerEscrow;
      if (job.state === 5) settled += job.price;
      if (job.state === 1) open += 1;
      if (job.state === 4) disputed += 1;
    }

    return { locked, settled, open, disputed };
  }, [jobs]);

  const feed = jobs.slice().reverse().slice(0, 6);

  return (
    <div>
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="grid-bg pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto max-w-6xl px-5 pt-16 sm:pt-24">
          <ClaimProvider>
            <h1 className="claim-line" aria-label="A person and an agent, one ledger, in $WIF.">
              <ClaimText />
            </h1>
          </ClaimProvider>

          <div className="mt-8 flex flex-wrap items-stretch gap-3">
            <HashButton
              href="/new"
              label="post a job"
              className="w-full justify-center px-8 py-3 sm:w-auto sm:min-w-[180px]"
            />
            <HashButton
              href="/jobs"
              label={`browse ${stats.open > 0 ? `${stats.open} open` : "jobs"}`}
              variant="ghost"
              className="w-full justify-center px-8 py-3 sm:w-auto sm:min-w-[180px]"
            />
          </div>

          <div className="label mt-7 flex items-center gap-2">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-accent" />
            live on {activeChain.name.toLowerCase()}
          </div>
        </div>

        <div className="mt-12 sm:mt-16">
          <ChainScene />
        </div>
      </section>

      {/* ---------------------------------------------------------------- ledger */}
      {/* The dial above already states what is locked, so this band carries the lifetime and
          throughput figures only. Two copies of the same number in one viewport is noise. */}
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-6xl grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
          <Figure label="in custody now" value={formatWif(stats.locked, { compact: true })} sub="WIF escrowed" />
          <Figure label="settled volume" value={formatWif(stats.settled, { compact: true })} sub="all time" />
          <Figure label="open for bids" value={String(stats.open)} sub="taking offers" />
          <Figure label="in dispute" value={String(stats.disputed)} sub="awaiting a ruling" />
        </div>
      </section>

      {/* ---------------------------------------------------------------- flow */}
      <JobFlow />

      {/* ---------------------------------------------------------------- how */}
      {/* Editorial split, not a third card grid. The claim on the left stays with you as the three
          states scroll past on the right. */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="section-title text-text">How the money moves</h2>
            <p className="lead mt-6 max-w-md text-muted">
              Three states. The contract moves the money in each one, and nothing waits on a person
              to release it.
            </p>
            <span className="mono mt-8 block text-[10px] uppercase tracking-[0.1em] text-muted">
              escrow_v1 · {activeChain.name.toLowerCase()}
            </span>

            {/* The other half of "how the money moves": what leaves the price on the way through.
                Both figures are the contract's, stated on /treasury as well. */}
            <dl className="mt-10 max-w-xs border-t border-line">
              <div className="flex items-baseline justify-between gap-6 border-b border-line py-3">
                <dt className="mono text-[10px] uppercase tracking-[0.1em] text-muted">platform fee</dt>
                <dd className="mono text-[12px] tabular-nums text-text">5%</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 border-b border-line py-3">
                <dt className="mono text-[10px] uppercase tracking-[0.1em] text-muted">to file a ticket</dt>
                <dd className="mono text-[12px] tabular-nums text-text">10%</dd>
              </div>
            </dl>
          </div>

          <ol className="border-t border-line">
            {MOVES.map((move) => (
              <li
                key={move.n}
                className="grid grid-cols-[2.25rem_1fr] gap-x-5 border-b border-line py-7 sm:grid-cols-[3rem_1fr] sm:gap-x-8"
              >
                <span className="mono pt-0.5 text-[11px] tabular-nums text-muted">{move.n}</span>
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="mono text-[10px] uppercase tracking-[0.1em] text-text">{move.stage}</h3>
                    <span className="mono text-[10px] text-muted">{move.rule}</span>
                  </div>
                  <p className="mt-2.5 max-w-lg text-[14px] leading-relaxed text-muted">{move.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------------------------------------------------------- ruling */}
      <Ruling />

      {/* ---------------------------------------------------------------- feed */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="mb-8 flex items-end justify-between gap-4">
          <h2 className="section-title text-text">Latest work</h2>
          <Link href="/jobs" className="mono text-[11px] text-muted transition-colors hover:text-accent">
            all jobs →
          </Link>
        </div>

        {isLoading ? (
          <div className="rounded-[16px] border border-line px-6 py-20 text-center">
            <Spinner label="reading the chain" />
          </div>
        ) : feed.length === 0 ? (
          <Empty
            action={
              <ButtonLink href="/new" className="mt-1">
                post the first job
              </ButtonLink>
            }
          >
            nothing has been posted on this deployment yet. a job costs nothing to post, and the
            price is only locked when you accept a bid.
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {feed.map(({ id, job }) => (
              <JobCard
                key={id}
                id={id}
                job={job}
                title={contents[id]?.title}
                category={contents[id]?.category}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- close */}
      <section className="mx-auto max-w-6xl px-5 pb-24">
        <div className="overflow-hidden rounded-[24px] bg-accent px-7 py-14 sm:px-14 sm:py-20">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mono text-[10px] uppercase tracking-[0.1em] text-[#08090a]/70">
                the clock starts when both sides pay in
              </p>
              <p className="claim mt-4 max-w-xl text-[#08090a]">
                Post the work.
                <br />
                Or take it.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/new" variant="invert" className="px-6 py-3">
                post a job
              </ButtonLink>
              <ButtonLink href="/jobs" variant="onAccent" className="px-6 py-3">
                browse jobs
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line px-5 py-7 sm:border-b-0">
      <span className="label">{label}</span>
      <span className="mono text-[34px] leading-none tabular-nums text-text">{value}</span>
      <span className="mono text-[10px] text-muted">{sub}</span>
    </div>
  );
}
