"use client";

import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ESCROW_ADDRESS, pactAbi } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { addressUrl } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import { useIsTreasury } from "@/lib/admin";
import { SessionGate } from "@/components/session-gate";
import { Badge, Button, Panel, SectionLabel } from "@/components/ui";

type Overview = {
  session: string;
  treasury: string;
  resolver: string;
  escrowBalance: string;
  treasuryBalance: string;
  treasuryClaimable: string;
  cut: string;
  filingFees: string;
  earned: string;
  locked: string;
  openLocked: string;
  counts: { settled: number; disputed: number; open: number; cancelled: number; tickets: number; total: number };
};

export default function TreasuryPage() {
  const { address } = useAccount();
  const { isTreasury } = useIsTreasury(address);

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <h1 className="text-2xl tracking-[-0.01em]">treasury</h1>
      <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
        The platform takes 5% of the price on every release, in either direction, plus a 10% filing fee on every
        ticket. It never takes a share of a slashed bond, and it cannot name a recipient.
      </p>

      <SessionGate<Overview>
        endpoint="/api/treasury/overview"
        canSign={isTreasury}
        deniedHint="This page is the fee ledger. Only the treasury wallet may read it — connect the treasury wallet and sign a message."
      >
        {(data, controls) => <TreasuryBody data={data} reload={controls.reload} />}
      </SessionGate>
    </div>
  );
}

function TreasuryBody({ data, reload }: { data: Overview; reload: () => void }) {
  const cut = BigInt(data.cut);
  const filingFees = BigInt(data.filingFees);
  const earned = BigInt(data.earned);
  const claimable = BigInt(data.treasuryClaimable);
  const balance = BigInt(data.treasuryBalance);
  /// Earned should be exactly what has been withdrawn plus what is still claimable.
  /// Anything else means the page and the chain disagree, so say so rather than hide it.
  const gap = earned - claimable - balance;

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const busy = isPending || confirming;

  return (
    <>
      <div className="mono mt-6 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-muted">
        <Badge tone="accent">treasury</Badge>
        <span>{shortAddress(data.session)}</span>
        <span>·</span>
        <span>
          {data.counts.settled} settled · {data.counts.disputed} disputed · {data.counts.open} open
        </span>
      </div>

      <Panel className="mt-4">
        <div className="grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-4">
          <Cell label="earned all-time" value={formatWif(earned, { compact: true })} sub={formatUsd(earned)} accent />
          <Cell label="5% platform cut" value={formatWif(cut, { compact: true })} sub={formatUsd(cut)} />
          <Cell
            label="ticket filing fees"
            value={formatWif(filingFees, { compact: true })}
            sub={`${data.counts.tickets} tickets`}
          />
          <Cell label="claimable now" value={formatWif(claimable, { compact: true })} sub={formatUsd(claimable)} />
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-2">
          <Row
            label="treasury wallet"
            value={shortAddress(data.treasury)}
            href={addressUrl(data.treasury)}
            note={`${formatWif(balance)} WIF withdrawn`}
          />
          <Row label="resolver" value={shortAddress(data.resolver)} href={addressUrl(data.resolver)} />
          <Row
            label="escrow holds"
            value={formatWif(BigInt(data.escrowBalance), { compact: true })}
            note="every job's WIF, not the platform's"
          />
          <Row
            label="still in escrow"
            value={formatWif(BigInt(data.openLocked) + BigInt(data.locked), { compact: true })}
            note="open budgets plus frozen tickets"
          />
        </div>
      </Panel>

      <Panel className="mt-5 p-5">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">withdraw</div>
        <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">
          Fees are credited to the treasury the moment a job settles or a ticket is filed — they are never
          pushed. <span className="mono text-text">claim()</span> moves whatever this address has accrued.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || claimable === 0n}
            onClick={() => writeContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "claim" })}
          >
            {busy
              ? "claiming…"
              : claimable === 0n
                ? "nothing to claim right now"
                : `claim ${formatWif(claimable)} WIF`}
          </Button>
          {gap !== 0n ? (
            <span className="mono text-[10px] text-warn">
              reconciliation gap of {formatWif(gap)} — the page and the chain disagree
            </span>
          ) : null}
        </div>

        {isSuccess ? (
          <div className="mono mt-3 flex items-center gap-3 border border-accent/30 bg-accent/[0.05] p-3 text-[10px] text-accent">
            claimed.
            <button onClick={reload} className="underline">
              refresh balances
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
            {friendlyError(error.message)}
            <button onClick={reset} className="ml-2 underline">
              dismiss
            </button>
          </div>
        ) : null}
      </Panel>

      <Panel className="mt-5 p-5">
        <SectionLabel>why the treasury is direction-neutral</SectionLabel>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          The 5% is charged whenever escrow is released — to a worker or back to an employer. Whichever way a
          ticket goes, the treasury earns the same amount. That removes any reason for the resolver to favour one
          side, which is the whole reason the resolver is safe to trust with a ruling.
        </p>
      </Panel>
    </>
  );
}

function Cell({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-4">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className={`mono text-lg leading-none ${accent ? "text-accent" : "text-text"}`}>{value}</span>
      {sub ? <span className="mono text-[9px] text-muted">{sub}</span> : null}
    </div>
  );
}

function Row({ label, value, href, note }: { label: string; value: string; href?: string; note?: string }) {
  return (
    <div className="flex items-center justify-between bg-panel px-4 py-3">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className="flex flex-col items-end">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="mono text-[11px] hover:text-accent">
            {value}
          </a>
        ) : (
          <span className="mono text-[11px]">{value}</span>
        )}
        {note ? <span className="mono text-[9px] text-muted">{note}</span> : null}
      </span>
    </div>
  );
}
