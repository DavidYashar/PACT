"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAllJobs } from "@/lib/hooks";
import { useJobContent } from "@/lib/use-content";
import { JobCard } from "@/components/job-card";
import { Button, Empty, Spinner } from "@/components/ui";

const FILTERS = [
  { key: "open", label: "open" },
  { key: "live", label: "in progress" },
  { key: "disputed", label: "disputed" },
  { key: "settled", label: "settled" },
  { key: "all", label: "all" },
] as const;

export default function JobsPage() {
  const { jobs, isLoading } = useAllJobs();
  const { contents } = useJobContent();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("open");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return jobs
      .filter(({ job }) => {
        if (filter === "open") return job.state === 1;
        if (filter === "live") return job.state === 2 || job.state === 3;
        if (filter === "disputed") return job.state === 4;
        if (filter === "settled") return job.state === 5;
        return true;
      })
      .filter(({ id }) => {
        if (!query.trim()) return true;
        const content = contents[id];
        const haystack = `${content?.title ?? ""} ${content?.category ?? ""} ${content?.description ?? ""}`;
        return haystack.toLowerCase().includes(query.trim().toLowerCase());
      })
      .sort((a, b) => b.id - a.id);
  }, [jobs, filter, query, contents]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="claim-tight text-text">jobs</h1>
          <p className="mt-1.5 text-[13px] text-muted">
            Every job below reads straight from the contract. Nothing here is a database record.
          </p>
        </div>
        <Link href="/new">
          <Button>post a job</Button>
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`mono border px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] transition-colors ${
              filter === f.key
                ? "border-accent text-accent bg-accent/5"
                : "border-line-2 text-muted hover:text-text"
            }`}
          >
            {f.label}
          </button>
        ))}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search terms…"
          className="mono ml-auto w-full max-w-[220px] border border-line-2 bg-panel-2 px-3 py-1.5 text-[11px]"
        />
      </div>

      {isLoading ? (
        <div className="rounded-[16px] border border-line px-6 py-20 text-center">
          <Spinner label="reading the chain" />
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {filter !== "all" ? (
                <Button variant="ghost" onClick={() => setFilter("all")}>
                  see all {jobs.length} jobs
                </Button>
              ) : null}
              <Link href="/new">
                <Button>post a job</Button>
              </Link>
            </div>
          }
        >
          {query.trim()
            ? `no job matches "${query.trim()}" under the ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} filter.`
            : filter === "open"
              ? `nothing is taking bids right now. ${jobs.length > 0 ? `${jobs.length} job${jobs.length === 1 ? " is" : "s are"} on chain, but none of them open.` : "the board is empty."}`
              : `nothing on chain is ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} right now.`}
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(({ id, job }) => (
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
    </div>
  );
}
