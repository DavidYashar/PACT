"use client";

import Link from "next/link";
import { Badge, Empty } from "@/components/ui";
import { SessionGate } from "@/components/session-gate";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";

type Ticket = {
  id: number;
  state: number;
  employer: string;
  worker: string;
  filer: string;
  price: string;
  bond: string;
  employerEscrow: string;
  workerEscrow: string;
  title: string | null;
  category: string | null;
  role: "resolver" | "employer" | "worker";
  settledTo: "worker" | "employer" | null;
};

type Payload = { session: string; isResolver: boolean; tickets: Ticket[] };

export default function TicketsPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">disputes</div>
      <h1 className="claim-tight mt-2 text-text">tickets</h1>
      <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
        A ticket freezes both escrows until it is ruled. Resolvers see every ticket; a party sees only the ones
        they are in. Nothing is listed before your wallet is signed in.
      </p>

      <SessionGate<Payload> endpoint="/api/tickets">
        {(data) => {
          if (data.tickets.length === 0) {
            return (
              <div className="mt-8">
                <Empty>
                  {data.isResolver
                    ? "no tickets right now."
                    : "you have no tickets. only disputes you are party to appear here."}
                </Empty>
              </div>
            );
          }

          const open = data.tickets.filter((t) => t.state === 4).length;

          return (
            <>
              <div className="mono mt-8 mb-3 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-muted">
                <span>
                  {data.tickets.length} {data.tickets.length === 1 ? "ticket" : "tickets"} · {open} in review
                </span>
                <span>{data.isResolver ? "resolver view · all tickets" : "your tickets only"}</span>
              </div>

              <div className="flex flex-col gap-3">
                {data.tickets.map((ticket) => (
                  <TicketRow key={ticket.id} ticket={ticket} />
                ))}
              </div>
            </>
          );
        }}
      </SessionGate>
    </div>
  );
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  const roleTone = ticket.role === "resolver" ? "accent" : ticket.role === "employer" ? "warn" : "muted";

  return (
    <Link
      href={`/tickets/${ticket.id}`}
      className="group block border border-line bg-panel p-5 transition-colors hover:border-line-2 hover:bg-panel-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">
            ticket #{ticket.id}
            {ticket.category ? ` · ${ticket.category}` : ""}
          </div>
          <div className="mt-1.5 text-[15px] leading-snug text-text group-hover:text-accent">
            {ticket.title ?? <span className="text-muted">terms not published</span>}
          </div>
          <div className="mono mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
            <span>filed by {shortAddress(ticket.filer)}</span>
            <span>·</span>
            <span>employer {shortAddress(ticket.employer)}</span>
            <span>·</span>
            <span>worker {shortAddress(ticket.worker)}</span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <Badge tone={roleTone}>{ticket.role}</Badge>
          {ticket.state === 4 ? (
            <Badge tone="danger">in review</Badge>
          ) : (
            <Badge tone="muted">
              settled{ticket.settledTo ? ` · ${ticket.settledTo}` : ""}
            </Badge>
          )}
        </div>
      </div>

      <div className="rule my-4" />

      <div className="mono flex flex-wrap items-center justify-between gap-3 text-[11px]">
        <div className="flex gap-5">
          <span className="text-muted">
            price <span className="text-text">{formatWif(BigInt(ticket.price))}</span>
          </span>
          <span className="text-muted">
            employer escrow <span className="text-text">{formatWif(BigInt(ticket.employerEscrow))}</span>
          </span>
          <span className="text-muted">
            worker escrow <span className="text-text">{formatWif(BigInt(ticket.workerEscrow))}</span>
          </span>
        </div>
        <span className="text-muted">{formatUsd(BigInt(ticket.price))}</span>
      </div>
    </Link>
  );
}
