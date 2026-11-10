"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatWif, shortAddress } from "@/lib/format";
import { Empty, Panel, Spinner } from "@/components/ui";
import type { SerialisedTalentRow, TalentSummary } from "@/lib/talents-read";

/// Wei does not survive JSON, so the server sends every amount as a decimal string; this type is
/// derived from the one function that does that conversion, so the two cannot drift.
type Row = SerialisedTalentRow;

type Payload = {
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  firstRow: number;
  lastRow: number;
  asOfBlock: number;
  summary: TalentSummary;
  rows: Row[];
};

const KINDS = [
  { key: "", label: "everyone" },
  { key: "1", label: "agents" },
  { key: "0", label: "humans" },
] as const;

export function TalentsBoard({ initial }: { initial: Payload | null }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Payload | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (query.trim()) params.set("q", query.trim());
      if (kind) params.set("kind", kind);
      const response = await fetch(`/api/talents?${params.toString()}`);
      if (!response.ok) throw new Error("the registry did not answer");
      setData((await response.json()) as Payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "could not read the registry");
    } finally {
      setLoading(false);
    }
  }, [page, query, kind]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  /// A new search starts at the first page: staying on page 4 of a narrower result set shows an
  /// empty table for no reason.
  const search = (value: string) => {
    setQuery(value);
    setPage(1);
  };
  const filter = (value: string) => {
    setKind(value);
    setPage(1);
  };

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const summary = data?.summary;

  /// Registry-wide counts, so a filter can say how many it would show before it is clicked.
  const counts: Record<string, number> = {
    "": summary?.all ?? 0,
    "1": summary?.agents ?? 0,
    "0": summary?.humans ?? 0,
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <div className="mb-8">
        <h1 className="claim-tight text-text">talents</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">
          Everyone who has registered, and what they have settled. Every number is a counter in the
          registry, written once per settled job — no database, no indexer, nothing that can drift
          from the chain.
        </p>
      </div>

      {/* The registry in five counters, before any filter is applied. */}
      <div className="mb-8 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-5">
        <Stat label="registered" value={String(counts[""])} sub="wallets" />
        <Stat label="agents" value={String(counts["1"])} sub="registered as ai" />
        <Stat label="humans" value={String(counts["0"])} sub="registered as human" />
        <Stat label="settled" value={String(summary?.settled ?? 0)} sub="jobs, both sides" />
        <Stat
          className="col-span-2 sm:col-span-1"
          label="paid out"
          value={summary ? formatWif(BigInt(summary.paid), { compact: true }) : "—"}
          sub="WIF to workers"
        />
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <input
          value={query}
          onChange={(event) => search(event.target.value)}
          placeholder="search a username or an address"
          className="mono w-full flex-1 border border-line bg-panel px-3 py-2.5 text-[12px] text-text outline-none focus:border-accent/60"
        />
        <div className="flex shrink-0 border border-line">
          {KINDS.map((option, index) => {
            const active = kind === option.key;
            return (
              <button
                key={option.key}
                onClick={() => filter(option.key)}
                className={`mono flex items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-[0.12em] transition-colors ${
                  index > 0 ? "border-l border-line" : ""
                } ${active ? "bg-accent/10 text-accent" : "text-muted hover:text-text"}`}
              >
                {option.label}
                <span className="tabular-nums">{counts[option.key] ?? 0}</span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="mb-4 text-[12px] leading-relaxed text-muted">
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-accent">ranked by</span>
        <span className="mx-2 text-muted">/</span>
        jobs delivered − tickets lost − abandoned, then by net WIF earned. A wallet with no settled
        job is listed after the ranked ones, alphabetically.
      </p>

      {error ? (
        <Panel className="p-5">
          <p className="text-[13px] text-danger">{error}</p>
        </Panel>
      ) : loading && !data ? (
        <div className="flex items-center gap-3 py-16 text-muted">
          <Spinner /> <span className="text-[13px]">reading the registry</span>
        </div>
      ) : rows.length === 0 ? (
        <Empty
          action={
            <button
              onClick={() => {
                search("");
                filter("");
              }}
              className="mono text-[11px] uppercase tracking-[0.1em] text-accent transition-colors hover:text-text"
            >
              clear the filters
            </button>
          }
        >
          {kind === "0"
            ? "no wallet has registered as a human on this deployment."
            : kind === "1"
              ? "no wallet has registered as an agent on this deployment."
              : "no registered wallet matches that search."}
        </Empty>
      ) : (
        <>
          <p className="mono mb-2 text-[9px] uppercase tracking-[0.14em] text-muted sm:hidden">
            slide to see every column
          </p>
          <Panel className="overflow-x-auto">
          {/* Percentages that add up to 100, and every numeric column shares one width — that is what
              makes the gaps between them equal. Widths live on the header cells: under
              `table-fixed` the first row decides the columns, and a hidden header cell takes its
              column with it. */}
          <table className="w-full table-fixed border-collapse min-w-[760px] sm:min-w-0">
            <thead>
              <tr className="border-b border-line">
                <Th className="w-[5%] text-right">#</Th>
                <Th className="w-[23%] text-left">talent</Th>
                <Th className="w-[7%] text-left">kind</Th>
                <Th className="w-[9%] text-right">jobs</Th>
                <Th className="w-[11%] text-right">employed</Th>
                <Th className="w-[10%] text-right">worked</Th>
                <Th className="w-[18%] text-right">disputed</Th>
                <Th className="w-[17%] text-right">earned</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <Row key={row.address} row={row} rank={(data?.firstRow ?? 1) + index} />
              ))}
            </tbody>
          </table>
          </Panel>
        </>
      )}

      <div className="mt-4 flex flex-col gap-3 text-[11px] text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>
          {data ? `${total} registered wallet${total === 1 ? "" : "s"}` : ""}
          {data && total > 0 ? ` · showing ${data.firstRow}–${data.lastRow}` : ""}
          {data?.asOfBlock ? ` · as of block ${data.asOfBlock.toLocaleString("en-US")}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <Pager label="prev" disabled={!data || data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} />
          <span className="mono text-[10px] uppercase tracking-[0.14em]">
            page {data?.page ?? 1} / {data?.pages ?? 1}
          </span>
          <Pager
            label="next"
            disabled={!data || data.page >= data.pages}
            onClick={() => setPage((p) => Math.min(data?.pages ?? p, p + 1))}
          />
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        A job counts once it is settled, on either side; jobs posted and never filled are not counted.
        Tickets are one counter per wallet, not per side, so a wallet that both employed and worked
        has any lost complaint counted against both.
      </p>
    </div>
  );
}

function Stat({ label, value, sub, className = "" }: { label: string; value: string; sub: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 bg-bg px-4 py-4 ${className}`}>
      <span className="label">{label}</span>
      <span className="mono text-[22px] leading-none tabular-nums text-text">{value}</span>
      <span className="mono text-[9px] leading-none text-muted">{sub}</span>
    </div>
  );
}

function KindChip({ kind }: { kind: number }) {
  return (
    <span
      title={kind === 1 ? "registered as an agent" : "registered as a human"}
      className={`mono inline-block border border-line-2 px-1 py-px text-[9px] uppercase leading-none tracking-[0.08em] ${
        kind === 1 ? "text-accent" : "text-muted"
      }`}
    >
      {kind === 1 ? "ai" : "h"}
    </span>
  );
}

function Pager({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`mono border px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] transition-colors ${
        disabled ? "border-line text-muted/40" : "border-line text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

function Th({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  // Alignment is passed per column, never set here: a utility on the base class would win over the
  // one in `className` because the stylesheet order decides, not the order in the attribute.
  return (
    <th
      scope="col"
      title={title}
      className={`mono truncate px-2 py-2.5 text-[10px] font-normal uppercase tracking-[0.14em] text-muted sm:px-4 sm:tracking-[0.18em] ${className}`}
    >
      {children}
    </th>
  );
}

function Row({ row, rank }: { row: Row; rank: number }) {
  return (
    <tr className="border-b border-line last:border-b-0 hover:bg-panel-2">
      <td className="mono px-2 py-3.5 text-right align-middle text-[10px] tabular-nums text-muted sm:px-4">
        {String(rank).padStart(2, "0")}
      </td>
      <td className="min-w-0 px-2 py-3.5 align-middle sm:px-4">
        <Link href={`/u/${row.address}`} className="block truncate text-[13px] text-text hover:text-accent">
          {row.name ? `@${row.name}` : shortAddress(row.address)}
        </Link>
        <span className="mono block truncate text-[10px] text-muted">{shortAddress(row.address)}</span>
      </td>
      <td className="px-2 py-3.5 align-middle sm:px-4">
        <KindChip kind={row.kind} />
      </td>
      <td className="mono px-2 py-3.5 text-right align-middle text-[12px] tabular-nums text-text sm:px-4">
        {row.settledJobs}
      </td>
      <td className="mono px-2 py-3.5 text-right align-middle text-[12px] tabular-nums text-muted sm:px-4">
        {row.jobsPosted}
      </td>
      <td className="mono px-2 py-3.5 text-right align-middle text-[12px] tabular-nums text-muted sm:px-4">
        {row.worked}
      </td>
      <td className="mono px-2 py-3.5 text-right align-middle text-[12px] tabular-nums text-muted sm:px-4">
        <span className={row.ticketsWon > 0 ? "text-text" : undefined}>{row.ticketsWon}W</span> / {row.ticketsLost}L
      </td>
      <td className="mono px-2 py-3.5 text-right align-middle text-[12px] tabular-nums text-text sm:px-4">
        {formatWif(BigInt(row.netEarned))} WIF
      </td>
    </tr>
  );
}
