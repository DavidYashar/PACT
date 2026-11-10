"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { keccak256, toHex } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ESCROW_ADDRESS, pactAbi } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { addressUrl } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import type { JobContent, JobProof, DisputeRecord, RulingNote } from "@/lib/content";
import { SessionGate } from "@/components/session-gate";
import { Badge, Button, Field, Panel, SectionLabel, inputClass } from "@/components/ui";

type JobView = {
  employer: string;
  worker: string;
  filer: string;
  state: number;
  budget: string;
  price: string;
  bond: string;
  employerEscrow: string;
  workerEscrow: string;
  proofHash: string;
  termsHash: string;
  reasonHash: string;
  timedOut: boolean;
};

type Payload = {
  session: string;
  isResolver: boolean;
  role: "resolver" | "employer" | "worker";
  jobId: number;
  job: JobView;
  resolver: string | null;
  content: JobContent | null;
  proof: JobProof | null;
  dispute: DisputeRecord | null;
  /// Does the stored complaint reproduce the on-chain `reasonHash`? Decided by the server.
  disputeVerified: boolean;
  /// Does the deliverable reproduce the on-chain `proofHash`?
  proofVerified: boolean;
  ruling: RulingNote | null;
};

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const jobId = Number(id);

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <Link href="/tickets" className="mono text-[10px] uppercase tracking-[0.16em] text-muted hover:text-accent">
        ← tickets
      </Link>

      <SessionGate<Payload> endpoint={`/api/tickets/${jobId}`}>
        {(data, controls) => <TicketBody data={data} reload={controls.reload} />}
      </SessionGate>
    </div>
  );
}

function TicketBody({ data, reload }: { data: Payload; reload: () => void }) {
  const { job, content, proof, dispute, ruling } = data;

  const price = BigInt(job.price);
  const bond = BigInt(job.bond);
  const employerEscrow = BigInt(job.employerEscrow);
  const workerEscrow = BigInt(job.workerEscrow);
  const cut = price / 20n;

  const [fineBps, setFineBps] = useState(1_000);
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const preview = useMemo(() => {
    const fineRaw = (bond * BigInt(fineBps)) / 10_000n;
    const fine = fineRaw > workerEscrow ? workerEscrow : fineRaw;
    return {
      fine,
      toWorkerKeep: employerEscrow - cut + workerEscrow,
      toEmployerWin: employerEscrow - cut + fine,
      toWorkerLose: workerEscrow - fine,
    };
  }, [bond, fineBps, workerEscrow, employerEscrow, cut]);

  const verifiedProof =
    proof?.proof && keccak256(toHex(proof.proof)).toLowerCase() === job.proofHash.toLowerCase();

  const isUrl = proof?.proof ? /^https?:\/\/\S+$/i.test(proof.proof.trim()) : false;
  const alreadyRuled = job.state !== 4;

  /// The contract refuses a ruling from a resolver that is a party to the job
  /// (`ResolverIsParty`). Detect it here so the buttons never appear to be a wallet bug.
  const me = data.session.toLowerCase();
  const isParty = me === job.employer.toLowerCase() || me === job.worker.toLowerCase();
  const canRule = data.isResolver && !isParty;

  function rule(favorWorker: boolean) {
    writeContract({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "resolveDispute",
      args: [BigInt(data.jobId), favorWorker ? 0 : 1, favorWorker ? 0 : fineBps],
    } as never);
  }

  return (
    <>
      <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mono flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted">
            <span>ticket #{data.jobId}</span>
            {content?.category ? (
              <>
                <span>/</span>
                <span>{content.category}</span>
              </>
            ) : null}
          </div>
          <h1 className="mt-2 text-2xl leading-tight tracking-[-0.01em]">
            {content?.title ?? <span className="text-muted">terms not published</span>}
          </h1>
        </div>
        <Badge tone={alreadyRuled ? "muted" : "danger"}>{alreadyRuled ? "settled" : "in review"}</Badge>
      </div>

      <Panel className="mt-6">
        <div className="grid grid-cols-2 divide-x divide-line sm:grid-cols-4">
          <Cell label="price" value={formatWif(price)} sub={formatUsd(price)} accent />
          <Cell label="employer escrow" value={formatWif(employerEscrow)} sub={formatUsd(employerEscrow)} />
          <Cell label="worker escrow" value={formatWif(workerEscrow)} sub={formatUsd(workerEscrow)} />
          <Cell label="your role" value={data.role} sub={shortAddress(data.session)} />
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-3">
          <Party label="employer" address={job.employer} you={data.role === "employer"} />
          <Party label="worker" address={job.worker} you={data.role === "worker"} />
          <Party label="filed by" address={job.filer} you={job.filer.toLowerCase() === data.session.toLowerCase()} />
        </div>
      </Panel>

      <StatusBanner jobId={data.jobId} settled={alreadyRuled} ruling={ruling} isResolver={data.isResolver} reload={reload} />

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Panel className="p-5">
          <div className="flex items-start justify-between gap-3">
            <SectionLabel>the complaint</SectionLabel>
            {dispute ? (
              <Badge tone={data.disputeVerified ? "accent" : "danger"}>
                {data.disputeVerified ? "matches the chain" : "not the committed text"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-text">
            {dispute?.reason ?? <span className="text-warn">complaint text not published for this ticket.</span>}
          </p>
          {dispute && !data.disputeVerified ? (
            <p className="mt-3 text-[11px] leading-relaxed text-danger">
              This text does not hash to the reason the filer committed to on chain. Treat it as an
              untrusted copy, not as the complaint.
            </p>
          ) : null}
        </Panel>

        <Panel className="p-5">
          <SectionLabel>the criteria it is judged against</SectionLabel>
          {content ? (
            <>
              <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{content.criteria}</p>
              <div className="rule my-4" />
              <SectionLabel>required proof</SectionLabel>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{content.proofSpec}</p>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-warn">terms not available — rule on the on-chain hashes only.</p>
          )}
        </Panel>
      </div>

      <Panel className="mt-5">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <SectionLabel>what was delivered</SectionLabel>
          {proof ? (
            <Badge tone={verifiedProof ? "accent" : "danger"}>{verifiedProof ? "hash verified" : "hash mismatch"}</Badge>
          ) : (
            <Badge tone="warn">not published</Badge>
          )}
        </div>
        <div className="p-5">
          {proof?.proof ? (
            isUrl ? (
              <a
                href={proof.proof.trim()}
                target="_blank"
                rel="noreferrer"
                className="break-all text-[14px] text-accent hover:underline"
              >
                {proof.proof.trim()}
              </a>
            ) : (
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text">{proof.proof}</p>
            )
          ) : (
            <p className="text-[13px] leading-relaxed text-warn">
              The worker committed a hash but never published the artifact here.
            </p>
          )}
          <div className="mono mt-4 break-all text-[10px] text-muted">{job.proofHash}</div>
        </div>
      </Panel>

      {data.isResolver ? (
        <Panel className="mt-5 p-5">
          <SectionLabel>
            {alreadyRuled ? "already ruled" : canRule ? "rule on this ticket" : "you cannot rule on this one"}
          </SectionLabel>

          {alreadyRuled ? (
            <p className="mt-3 text-[13px] text-muted">
              This job is settled. Payouts are pull-based — each party claims from the header.
            </p>
          ) : !canRule ? (
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-[13px] leading-relaxed text-warn">
                This wallet is the {me === job.employer.toLowerCase() ? "employer" : "worker"} on job #
                {data.jobId}, and the contract refuses a ruling from a resolver that is a party to the job. It
                is a deliberate guard — without it a deployer who is also the resolver could post a job, take
                the bid, and rule in its own favour to seize the bond.
              </p>
              <p className="text-[13px] leading-relaxed text-muted">
                Two ways out: transfer the resolver role to another wallet with{" "}
                <code className="mono text-[11px] text-text">transferResolver</code> on the admin page, or let
                this ticket be decided by whoever holds the role then.
              </p>
              <Link
                href="/admin"
                className="mono w-fit border border-line px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-muted transition-colors hover:border-accent/40 hover:text-accent"
              >
                go to admin
              </Link>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted">fine if worker loses</span>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={50}
                  value={fineBps}
                  onChange={(e) => setFineBps(Number(e.target.value))}
                  className="w-full max-w-[220px] accent-[#c8f751]"
                />
                <span className="mono text-[11px] text-text">
                  {(fineBps / 100).toFixed(0)}% · {formatWif(preview.fine)} WIF
                </span>
              </div>

              <div className="mt-5 grid gap-px bg-line sm:grid-cols-2">
                <Option
                  title="favour the worker"
                  employer={0n}
                  worker={preview.toWorkerKeep}
                  treasury={cut}
                  onRule={() => rule(true)}
                  disabled={isPending || confirming || isSuccess}
                />
                <Option
                  title="favour the employer"
                  employer={preview.toEmployerWin}
                  worker={preview.toWorkerLose}
                  treasury={cut}
                  onRule={() => rule(false)}
                  disabled={isPending || confirming || isSuccess}
                  danger
                />
              </div>
            </>
          )}

          {error ? (
            <div className="mt-3 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
              {friendlyError(error.message)}
              <button onClick={reset} className="ml-2 underline">
                dismiss
              </button>
            </div>
          ) : null}

          {isSuccess ? (
            <div className="mono mt-3 flex items-center gap-3 border border-accent/30 bg-accent/[0.05] p-3 text-[10px] text-accent">
              ruled. money is claimable, not pushed.
              <button onClick={reload} className="underline">
                refresh
              </button>
            </div>
          ) : null}
        </Panel>
      ) : (
        <Panel className="mt-5 p-5">
          <SectionLabel>what happens next</SectionLabel>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            {alreadyRuled
              ? "The ticket is closed. You can read the whole case here — the complaint, the criteria and the deliverable — but the ruling is final, and only the resolver wallet could ever have moved this money."
              : "Both escrows stay frozen until the resolver rules. You can read the whole case here — the complaint, the criteria and the deliverable — but only the resolver can move the money."}
          </p>
        </Panel>
      )}
    </>
  );
}

/// What a party is allowed to see about the outcome: the status, which side won, and the
/// resolver's reasoning. Never a control — only the resolver gets one of those.
function StatusBanner({
  jobId,
  settled,
  ruling,
  isResolver,
  reload,
}: {
  jobId: number;
  settled: boolean;
  ruling: RulingNote | null;
  isResolver: boolean;
  reload: () => void;
}) {
  if (!settled) {
    return (
      <Panel className="mt-5 p-5">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-danger">in review</div>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
          The resolver has not decided yet. Both escrows stay frozen until the ruling lands — neither party can
          move anything in the meantime, and neither party writes the outcome.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="mt-5 p-5">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">settled</div>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-text">
        {ruling ? (
          <>
            Ruled in favour of the <span className="text-accent">{ruling.ruling}</span>. The frozen escrow was
            released to that side and the ticket is closed.
          </>
        ) : (
          "The escrow was released and the ticket is closed."
        )}
      </p>

      {ruling ? (
        <>
          <div className="rule my-4" />
          <SectionLabel>the resolver&apos;s reasoning</SectionLabel>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{ruling.note}</p>
          <p className="mono mt-3 text-[9px] text-muted">
            written by {shortAddress(ruling.resolver)} · {ruling.recordedAt.slice(0, 10)}
          </p>
        </>
      ) : isResolver ? null : (
        <p className="mt-3 text-[12px] text-muted">The resolver has not published a reason for this one.</p>
      )}

      {isResolver ? <NoteForm jobId={jobId} existing={ruling} reload={reload} /> : null}
    </Panel>
  );
}

function NoteForm({ jobId, existing, reload }: { jobId: number; existing: RulingNote | null; reload: () => void }) {
  const [ruling, setRuling] = useState<"worker" | "employer">(existing?.ruling ?? "worker");
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/rulings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, ruling, note: note.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "could not save the note");
        return;
      }
      reload();
    } catch {
      setError("the server did not respond");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <SectionLabel>{existing ? "rewrite the note" : "explain the ruling"}</SectionLabel>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Both parties can read this. The contract only stores the ruling enum, so this is the only place the
        reasoning lives.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {(["worker", "employer"] as const).map((side) => (
          <button
            key={side}
            onClick={() => setRuling(side)}
            className={`mono border px-3 py-2 text-[10px] uppercase tracking-[0.14em] transition-colors ${
              ruling === side ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-text"
            }`}
          >
            in favour of the {side}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <Field label="why">
          <textarea
            className={`${inputClass} min-h-[84px] resize-y`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="the deliverable did not match the acceptance criteria because…"
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button disabled={busy || note.trim().length < 10} onClick={submit}>
          {busy ? "saving…" : existing ? "update the note" : "publish the note"}
        </Button>
        <span className="mono text-[9px] text-muted">{note.trim().length} / 2000</span>
      </div>

      {error ? <div className="mt-3 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">{error}</div> : null}
    </div>
  );
}

function Cell({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-4">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className={`mono text-[15px] leading-tight ${accent ? "text-accent" : "text-text"}`}>{value}</span>
      {sub ? <span className="mono text-[9px] text-muted">{sub}</span> : null}
    </div>
  );
}

function Party({ label, address, you }: { label: string; address: string; you: boolean }) {
  return (
    <div className="flex items-center justify-between bg-panel px-4 py-3">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className="flex items-center gap-2">
        {you ? <Badge tone="accent">you</Badge> : null}
        <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="mono text-[11px] hover:text-accent">
          {shortAddress(address)}
        </a>
      </span>
    </div>
  );
}

function Option({
  title,
  employer,
  worker,
  treasury,
  onRule,
  disabled,
  danger,
}: {
  title: string;
  employer: bigint;
  worker: bigint;
  treasury: bigint;
  onRule: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 bg-panel p-5">
      <div className="mono text-[10px] uppercase tracking-[0.16em] text-text">{title}</div>
      <div className="mono flex flex-col gap-1 text-[10px]">
        <Line label="→ employer" value={employer} />
        <Line label="→ worker" value={worker} />
        <Line label="→ treasury" value={treasury} />
      </div>
      <Button variant={danger ? "danger" : "ghost"} onClick={onRule} disabled={disabled} className="mt-1">
        rule this way
      </Button>
    </div>
  );
}

function Line({ label, value }: { label: string; value: bigint }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={value === 0n ? "text-muted" : "text-text"}>{formatWif(value)}</span>
    </div>
  );
}
