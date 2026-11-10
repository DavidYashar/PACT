"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keccak256, toHex } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { ESCROW_ADDRESS, STATE_LABEL, WIF_ADDRESS, erc20Abi, pactAbi, type Bid, type Job } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { txUrl, addressUrl, TAB_LOGS } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import { useBids, useClaimable, useJob, useWifBalance } from "@/lib/hooks";
import { useIsRegistered, useMinCountedPrice, useRecord } from "@/lib/names";
import { SettledActions } from "@/components/settled-actions";
import { UsernameRequired } from "@/components/username-required";
import { AddressName } from "@/components/address-name";
import { RecordLink } from "@/components/record-link";
import { useSingleJobContent } from "@/lib/use-content";
import { useSessionSignIn } from "@/lib/use-sign-in";
import type { JobProof } from "@/lib/content";
import { Countdown, Since } from "@/components/countdown";
import { DeadlineRing } from "@/components/deadline-ring";
import { Badge, Button, Field, LockPulse, Panel, PanelHeader, SectionLabel, Spinner, StateBadge, StateSteps, inputClass } from "@/components/ui";

/// What the registry compares against its floor: the accepted price once there is one, and the
/// budget while the job is still open — a job that opens under the floor cannot settle above it.
function settledPrice(job: Job): bigint {
  return job.price > 0n ? job.price : job.budget;
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const jobId = Number(id);
  const { address } = useAccount();
  const { data, isLoading } = useJob(jobId);
  const { data: bidsData } = useBids(jobId);
  const { content, pitches, proof: storedProof, privileged, parties, reload: reloadContent } = useSingleJobContent(jobId);
  const countedAt = useMinCountedPrice();

  const job = data as Job | undefined;
  const bids = (bidsData as Bid[] | undefined) ?? [];

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-5 py-24 text-center">
        <Spinner label="reading the job" />
      </div>
    );
  }

  if (!job || job.employer === "0x0000000000000000000000000000000000000000") {
    return (
      <div className="mx-auto max-w-4xl px-5 py-24 text-center">
        <p className="text-muted">no job #{jobId}.</p>
        <Link href="/jobs" className="mono mt-4 inline-block text-[11px] text-accent hover:underline">
          ← all jobs
        </Link>
      </div>
    );
  }

  const isEmployer = address?.toLowerCase() === job.employer.toLowerCase();
  const isWorker = address?.toLowerCase() === job.worker.toLowerCase();

  /// The job states its own position using the contract's own states. A ticket replaces the last
  /// step rather than adding a fifth, because a disputed job is still heading for settlement.
  const cancelled = job.state === 6;
  const steps = cancelled ? ["posted", "cancelled"] : job.state === 4 ? ["posted", "assigned", "delivered", "ticket"] : ["posted", "assigned", "delivered", "settled"];
  const stepAt = cancelled ? 2 : job.state === 1 ? 1 : job.state === 2 ? 2 : job.state === 3 ? 3 : job.state === 4 ? 4 : 5;

  /// The deadline that decides this job right now, and the window it sits in. `from` is only known
  /// once a delivery exists, because the contract stores absolute deadlines and not their start.
  const deadline =
    job.state === 1
      ? { target: job.bidDeadline, from: undefined, label: "bids close in" }
      : job.state === 2
        ? { target: job.deliveryDeadline, from: undefined, label: "deliver in" }
        : job.state === 3
          ? { target: job.autoReleaseAt, from: job.autoReleaseAt - job.autoReleaseDelay, label: "auto-release" }
          : null;

  return (
    <div className="mx-auto max-w-4xl px-5 py-10">
      <Link href="/jobs" className="label hover:text-accent">
        ← jobs
      </Link>

      <div className="mt-5">
        <div className="mono mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-muted">
          <span>job #{jobId}</span>
          {content?.category ? (
            <>
              <span className="text-muted">/</span>
              <span>{content.category}</span>
            </>
          ) : null}
        </div>
        {content ? (
          <h1 className="claim-tight max-w-3xl text-text">{content.title}</h1>
        ) : job.state === 5 ? (
          <>
            <div className="label">settled · terms retired, hash is permanent</div>
            <h1 className="mono mt-2 break-all text-[12px] leading-relaxed text-text">{job.termsHash}</h1>
          </>
        ) : (
          <h1 className="claim-tight max-w-3xl text-muted">terms not published</h1>
        )}
        {/* The badge and the sequence sit under the claim, on one line: the state of the job is
            part of what the job says about itself, not a floating ornament in the corner. */}
        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
          <StateBadge state={job.state} label={STATE_LABEL[job.state] ?? "—"} />
          <StateSteps steps={steps} current={stepAt} />
        </div>
      </div>

      {/* the escrow panel is the hero: who locked what, and what unlocks it */}
      <Panel className="mt-7">
        <PanelHeader
          title="escrow in custody"
          note={
            job.state === 5
              ? "settled. both stakes have left custody."
              : "money moves only when the work lands, or when a ticket rules. nobody at the platform can touch it."
          }
          action={<LockPulse label={job.state === 5 ? "closed" : "locked"} active={job.state !== 5} />}
        />
        <div className={`grid ${deadline ? "lg:grid-cols-[210px_1fr]" : ""}`}>
          {deadline ? (
            <div className="flex items-center justify-center border-b border-line px-5 py-7 lg:border-r lg:border-b-0">
              <DeadlineRing target={deadline.target} from={deadline.from} label={deadline.label} />
            </div>
          ) : null}
          <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Cell
              label="employer locked"
              value={formatWif(job.state === 1 ? job.budget : job.employerEscrow)}
              sub={formatUsd(job.state === 1 ? job.budget : job.employerEscrow)}
              accent
            />
            <Cell label="worker locked" value={formatWif(job.workerEscrow)} sub={formatUsd(job.workerEscrow)} />
            <Cell label="price" value={formatWif(job.price || job.budget)} sub={formatUsd(job.price || job.budget)} />
          </div>
        </div>

        <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2">
          <Party role="employer" address={job.employer} isYou={isEmployer} />
          <Party
            role="worker"
            address={job.worker === "0x0000000000000000000000000000000000000000" ? undefined : job.worker}
            isYou={isWorker}
          />
        </div>

        {/* Below the registry's floor the money still moves in full; only the reputation is
            withheld. Said here, where the stakes already are, rather than in a footnote. */}
        {countedAt !== undefined && settledPrice(job) > 0n && settledPrice(job) < countedAt ? (
          <div className="border-t border-line px-5 py-3">
            <p className="text-[11px] leading-relaxed text-muted">
              The registry counts a settled job at {formatWif(countedAt)} WIF and above. At{" "}
              {formatWif(settledPrice(job))} WIF this one settles and pays in full, but it moves no
              reputation counter and enters neither party&apos;s history.
            </p>
          </div>
        ) : null}
      </Panel>

      {content ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Panel className="p-5">
            <SectionLabel>detail</SectionLabel>
            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{content.description}</p>
          </Panel>
          <Panel className="p-5">
            <SectionLabel>acceptance criteria</SectionLabel>
            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{content.criteria}</p>
            <div className="rule my-4" />
            <SectionLabel>proof</SectionLabel>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{content.proofSpec}</p>
            {content.expectedProofHash ? (
              <>
                <div className="rule my-4" />
                <SectionLabel>self-verifying</SectionLabel>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">
                  The employer committed to one exact deliverable. A delivery whose digest equals this
                  value can be approved with no judgment; anything else is not the artefact the job
                  asked for.
                </p>
                <p className="mt-2 break-all font-mono text-[11px] text-muted">{content.expectedProofHash}</p>
              </>
            ) : null}
          </Panel>
        </div>
      ) : null}

      <DisputeNotice job={job} jobId={jobId} privileged={privileged} />

      <Deliverable
        job={job}
        proof={storedProof}
        privileged={privileged}
        parties={parties}
        reload={reloadContent}
      />

      <Actions
        job={job}
        jobId={jobId}
        isEmployer={isEmployer}
        isWorker={isWorker}
        bids={bids}
        pitches={pitches}
        onNoteSaved={reloadContent}
      />


      <BidList job={job} jobId={jobId} bids={bids} pitches={pitches} isEmployer={isEmployer} />

      <Panel className="mt-5 p-5">
        <SectionLabel>on-chain record</SectionLabel>
        <div className="mt-3 flex flex-col gap-2">
          <HashRow label="terms" hash={job.termsHash} />
          <HashRow label="proof" hash={job.proofHash} />
          {job.state === 5 ? <SettlementRows jobId={jobId} job={job} /> : null}
          {job.autoReleaseAt > 0n && job.state !== 5 ? (
            <div className="mono flex justify-between gap-4 text-[11px]">
              <span className="text-muted">auto-release</span>
              <span className="text-text">
                {job.state === 4 ? (
                  "frozen while the ticket is open"
                ) : (
                  <>
                    <Countdown target={job.autoReleaseAt} /> ·{" "}
                    <Since from={job.autoReleaseAt - job.autoReleaseDelay} />
                  </>
                )}
              </span>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function Cell({
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
    <div className="flex flex-col gap-1.5 px-5 py-6">
      <span className="label">{label}</span>
      <span className={`mono text-[26px] leading-none tabular-nums ${accent ? "text-accent" : "text-text"}`}>{value}</span>
      {sub ? <span className="mono text-[10px] text-muted">{sub}</span> : null}
    </div>
  );
}

function Party({ role, address, isYou }: { role: string; address?: string; isYou: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-panel px-5 py-4">
      <span className="label">{role}</span>
      <span className="flex items-center gap-2">
        {isYou && address ? <Badge tone="accent">you</Badge> : null}
        <AddressName address={address} />
      </span>
    </div>
  );
}

function HashRow({ label, hash }: { label: string; hash: string }) {
  const empty = !hash || /^0x0+$/.test(hash);
  return (
    <div className="mono flex justify-between gap-4 text-[11px]">
      <span className="text-muted">{label}</span>
      <span className={empty ? "text-muted" : "text-text break-all text-right"}>{empty ? "—" : hash}</span>
    </div>
  );
}

/// A settled job is read straight off the registry: the escrow keeps the settlement facts, and
/// the registry keeps the same job as a permanent entry. Nothing here comes from a database.
function SettlementRows({ jobId, job }: { jobId: number; job: Job }) {
  const { data: record } = useRecord(jobId);
  const inscribed = Boolean(record && record.recordedBy !== "0x0000000000000000000000000000000000000000");

  return (
    <>
      <div className="rule my-2" />
      <div className="mono flex justify-between gap-4 text-[11px]">
        <span className="text-muted">settled to</span>
        <span className={job.workerWon ? "text-accent" : "text-text"}>
          {job.workerWon ? "worker" : "employer"}
        </span>
      </div>
      <div className="mono flex justify-between gap-4 text-[11px]">
        <span className="text-muted">paid to worker</span>
        <span className="text-text">{formatWif(job.workerWon ? job.toWorkerPaid : 0n)} WIF</span>
      </div>
      <div className="mono flex justify-between gap-4 text-[11px]">
        <span className="text-muted">spent by employer</span>
        <span className="text-text">{formatWif(job.workerWon ? job.price : 0n)} WIF</span>
      </div>
      <div className="mono flex justify-between gap-4 text-[11px]">
        <span className="text-muted">ticket</span>
        <span className="text-text">{job.filer === "0x0000000000000000000000000000000000000000" ? "none" : "yes"}</span>
      </div>
      <div className="mono flex justify-between gap-4 text-[11px]">
        <span className="text-muted">registry</span>
        <span className={inscribed ? "text-accent" : "text-muted"}>
          {inscribed ? "inscribed" : "not inscribed yet"}
        </span>
      </div>
      <RecordLink jobId={jobId} inscribed={inscribed} />
    </>
  );
}

function DisputeNotice({ job, jobId, privileged }: { job: Job; jobId: number; privileged: boolean }) {
  if (job.state !== 4) return null;
  return (
    <div className="mt-5 border border-danger/40 bg-danger/[0.05] p-5">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-danger">ticket open</div>
      <p className="mt-2 text-[13px] leading-relaxed text-danger/90">
        Both escrows are frozen. Filed by {shortAddress(job.filer)}. The ruling moves money only between the
        employer, the worker and the treasury — the resolver cannot name a recipient.
      </p>
      {privileged ? (
        <Link href={`/tickets/${jobId}`} className="mono mt-3 inline-block text-[11px] text-danger hover:underline">
          open the ticket →
        </Link>
      ) : (
        <p className="mt-3 text-[12px] text-muted">the complaint itself is private to the two parties.</p>
      )}
    </div>
  );
}

/// The employer has to be able to read what was delivered. The chain only stores a
/// hash, so the payload lives off-chain and is verified by rehashing it here and
/// comparing against the value the worker committed.
function Deliverable({
  job,
  proof,
  privileged,
  parties,
  reload,
}: {
  job: Job;
  proof?: JobProof | null;
  privileged: boolean;
  parties: { employer: string; worker: string; resolver: string | null } | null;
  reload: () => void;
}) {
  const { address } = useAccount();
  const { signIn, signing, error } = useSessionSignIn();
  const empty = !job.proofHash || /^0x0+$/.test(job.proofHash);
  if (empty) return null;

  /// The withheld deliverable is not a wall for the people it belongs to — if this wallet
  /// is a party, the only thing missing is a signed session.
  const me = address?.toLowerCase();
  const entitled =
    Boolean(me) &&
    Boolean(parties) &&
    (parties!.employer.toLowerCase() === me ||
      (parties!.worker !== "0x0000000000000000000000000000000000000000" && parties!.worker.toLowerCase() === me) ||
      (parties!.resolver !== null && parties!.resolver.toLowerCase() === me));

  const text = proof?.proof ?? "";
  const recomputed = text ? keccak256(toHex(text)) : undefined;
  const verified = recomputed !== undefined && recomputed.toLowerCase() === job.proofHash.toLowerCase();

  const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
  /// Settlement deletes the text on purpose. The hash is what survives, and it is permanent —
  /// so this is a finished record, not a missing one.
  const retired = !text && job.state === 5;

  return (
    <Panel className="mt-5">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <SectionLabel>deliverable</SectionLabel>
        {text ? (
          <Badge tone={verified ? "accent" : "danger"}>{verified ? "hash verified" : "hash mismatch"}</Badge>
        ) : retired ? (
          <Badge tone="muted">hash only</Badge>
        ) : (
          <Badge tone="warn">text not published</Badge>
        )}
      </div>

      <div className="p-5">
        {text ? (
          <>
            {isUrl ? (
              <a
                href={text.trim()}
                target="_blank"
                rel="noreferrer"
                className="break-all text-[14px] text-accent hover:underline"
              >
                {text.trim()}
              </a>
            ) : (
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text">{text}</p>
            )}

            <div className="rule my-4" />

            <div className="mono flex flex-col gap-1.5 text-[10px]">
              <div className="flex justify-between gap-4">
                <span className="text-muted">on-chain hash</span>
                <span className="break-all text-right text-text">{job.proofHash}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted">rehash of this text</span>
                <span className={`break-all text-right ${verified ? "text-accent" : "text-danger"}`}>
                  {recomputed}
                </span>
              </div>
            </div>

            {!verified ? (
              <p className="mt-3 text-[11px] leading-relaxed text-danger">
                The stored text does not hash to what was committed on-chain. Treat it as unverified.
              </p>
            ) : null}
          </>
        ) : retired ? (
          <>
            <p className="text-[13px] leading-relaxed text-muted">
              The deliverable text was destroyed when this job settled, by design: once the work is
              paid for, the hash below is the whole record. It is the same value that was committed
              before the deadline and written into the registry, so it can be checked against the
              worker&apos;s own copy of the artifact at any time.
            </p>
            <div className="mono mt-3 break-all text-[10px] text-text">{job.proofHash}</div>
          </>
        ) : privileged ? (
          <>
            <p className="text-[13px] leading-relaxed text-warn">
              The worker committed a hash but the deliverable itself was never published here. Only the hash
              below is on-chain — ask the worker for the artifact before approving.
            </p>
            <div className="mono mt-3 break-all text-[10px] text-muted">{job.proofHash}</div>
          </>
        ) : entitled ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] leading-relaxed text-warn">
              The deliverable is here, but this browser has not signed in with this wallet yet. Sign a message —
              no gas, no transaction — and it will appear.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={signing}
                onClick={async () => {
                  const ok = await signIn();
                  if (ok) reload();
                }}
              >
                {signing ? "waiting for signature…" : "sign in to read it"}
              </Button>
              <span className="mono text-[10px] text-muted">{address ? shortAddress(address) : ""}</span>
            </div>
            {error ? (
              <p className="border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">{error}</p>
            ) : null}
          </div>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-warn">
              The deliverable is private to the employer, the worker and the resolver. Only its commitment is
              public.
            </p>
            <div className="mono mt-3 break-all text-[10px] text-muted">{job.proofHash}</div>
          </>
        )}

        <div className="mono mt-4 flex items-center gap-2 text-[10px] text-muted">
          <span>delivered by</span>
          <AddressName address={job.worker} />
          {job.autoReleaseAt > 0n ? (
            <>
              <span>·</span>
              <Since from={job.autoReleaseAt - job.autoReleaseDelay} />
            </>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function Actions({
  job,
  jobId,
  isEmployer,
  isWorker,
  bids,
  pitches,
  onNoteSaved,
}: {
  job: Job;
  jobId: number;
  isEmployer: boolean;
  isWorker: boolean;
  bids: Bid[];
  pitches: { bidIndex: number; worker: string; pitch: string }[];
  onNoteSaved?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const { ready: nameReady, registered } = useIsRegistered(address);
  const client = usePublicClient();
  const [price, setPrice] = useState("");
  const [pitch, setPitch] = useState("");
  const [proof, setProof] = useState("");

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const { signIn } = useSessionSignIn();
  const busy = isPending || confirming;

  const bidCount = bids.length;

  /// The last write's identity. `isSuccess` is shared by every action in this panel, so
  /// a plain success flag cannot tell a completed bid from a completed approval.
  const action = useRef<"approve" | "bid" | null>(null);
  const [bidPlaced, setBidPlaced] = useState(false);
  /// A pitch is the only write the chain cannot vouch for, so the server wants a signed session for
  /// it and that request can fail after the bid has already landed. When it does, the bid is on chain
  /// and the note beside it is gone, with nothing on screen saying so — which is what this holds.
  const [noteProblem, setNoteProblem] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const call = useCallback(
    (functionName: string, args: unknown[], kind: "approve" | "bid" | null = null) => {
      action.current = kind;
      writeContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName, args } as never);
    },
    [writeContract],
  );

  /// Off-chain records can only be published once the chain agrees they exist — the
  /// server verifies every write against the contract. So the payload waits here until
  /// the transaction receipt lands. A function body is resolved at that point, which is
  /// how the pitch finds the bid index the contract actually assigned it.
  const pendingWrite = useRef<{ path: string; body: unknown | (() => Promise<unknown>) } | null>(null);

  /// Publish the note beside a bid and report why it failed, if it did. The index comes from the
  /// chain rather than from what the page thinks, because a bid placed a moment ago may already have
  /// moved it.
  const publishNote = useCallback(
    async (text: string): Promise<string | null> => {
      if (!address || !client) return "connect the wallet that placed the bid";
      let index = -1;
      try {
        const fresh = (await client.readContract({
          address: ESCROW_ADDRESS,
          abi: pactAbi,
          functionName: "getBids",
          args: [BigInt(jobId)],
        })) as Bid[];
        index = fresh.findIndex((b) => b.worker.toLowerCase() === address.toLowerCase());
      } catch {
        return "could not read the bids back from the chain";
      }
      if (index < 0) return "the chain has no bid from this wallet on this job";

      const post = () =>
        fetch("/api/pitches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, bidIndex: index, worker: address, pitch: text.trim() || "—" }),
        }).catch(() => null);

      let res = await post();
      if (res && res.status === 401 && (await signIn())) res = await post();
      if (!res) return "the note could not be sent";
      if (res.ok) return null;
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      return payload.error ?? `the server refused the note (http ${res.status})`;
    },
    [address, client, jobId, signIn],
  );

  useEffect(() => {
    if (!isSuccess) return;

    if (action.current === "bid") setBidPlaced(true);

    const pending = pendingWrite.current;
    if (!pending) return;
    pendingWrite.current = null;

    void (async () => {
      const body = typeof pending.body === "function" ? await pending.body() : pending.body;

      if (pending.path === "/api/pitches") {
        const text = (body as { pitch?: string }).pitch ?? "";
        setNoteDraft(text);
        const problem = await publishNote(text);
        setNoteProblem(problem);
        if (!problem) onNoteSaved?.();
        return;
      }

      const send = () =>
        fetch(pending.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      let res = await send().catch(() => null);
      /// A pitch is signed content — the note belongs to the wallet that wrote it — so the server
      /// wants a session for that one write. Everything else here is verified by re-deriving an
      /// on-chain hash instead. Ask for the signature only when the cookie is actually missing,
      /// and only once, so a bid does not silently lose its note.
      if (res && res.status === 401 && (await signIn())) {
        res = await send().catch(() => null);
      }
    })().catch(() => undefined);
  }, [isSuccess, publishNote, onNoteSaved, signIn]);

  /// Once this wallet has a bid on this job there is nothing to place again — the button
  /// stays off across reloads, not just until the bids list refreshes.
  const myBid = bids.find((b) => b.worker.toLowerCase() === address?.toLowerCase());
  const alreadyBid = bidPlaced || Boolean(myBid);

  /// A bid only commits to a price; the bond is pulled when the employer accepts.
  /// Without this allowance the worker's bid succeeds and the employer's accept reverts.
  /// The same applies to the employer's filing fee, which is pulled as new WIF.
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: WIF_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, ESCROW_ADDRESS] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 4000 },
  });

  /// Settlement credits a balance; it never pushes tokens. So the settled copy has to know
  /// whether this wallet still has something to collect from the header button.
  const { data: claimable } = useClaimable(address);

  /// The bond is pulled when the employer accepts, not when the bid is placed — which is
  /// why an unfunded wallet could bid and leave the employer holding an un-acceptable bid.
  const { data: wifBalance } = useWifBalance(address);
  const myBalance = (wifBalance as bigint | undefined) ?? 0n;

  const body = useMemo(() => {
    if (!isConnected) return <p className="mono text-[11px] text-muted">connect a wallet to act on this job.</p>;

    if (job.state === 1) {
      if (isEmployer) {
        return (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted">
              Accept a bid below, or cancel the job to get your full {formatWif(job.budget)} WIF back.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="ghost" disabled={busy} onClick={() => call("cancelJob", [BigInt(jobId)])}>
                {busy ? "cancelling…" : `cancel job — refund ${formatWif(job.budget)} WIF`}
              </Button>
              <span className="mono text-[10px] text-muted">
                refund lands in your claimable balance, then claim it from the header
              </span>
            </div>
          </div>
        );
      }
      const priceWei = BigInt(Math.round(Number(price || "0"))) * 10n ** 18n;
      const requiredBond = priceWei / 2n;
      const approved = (allowance as bigint | undefined) ?? 0n;
      const needsApproval = requiredBond > 0n && approved < requiredBond;
      const shortOfBond = requiredBond > 0n && myBalance < requiredBond;

      if (alreadyBid) {
        const myIndex = myBid ? bids.findIndex((b) => b.worker.toLowerCase() === myBid.worker.toLowerCase()) : -1;
        const hasNote = myIndex >= 0 && pitches.some((p) => p.bidIndex === myIndex);
        return (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] leading-relaxed text-accent">
              Your bid is in{myBid ? ` — ${formatWif(myBid.price)} WIF` : ""}. The employer decides which bid to
              accept; nothing is pulled from your wallet until they accept yours.
            </p>
            {!hasNote ? (
              <div className="border border-warn/40 bg-warn/5 p-3 text-[12px] leading-relaxed text-warn">
                <p>
                  This bid has no note attached. The chain holds your price; the text beside it is stored
                  separately and needs a wallet signature, so it can fail on its own without the bid failing.
                </p>
                {noteProblem ? <p className="mt-1 text-danger">{noteProblem}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className={inputClass}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="how you'll deliver, and when"
                    disabled={busy}
                  />
                  <Button
                    variant="ghost"
                    disabled={busy || !noteDraft.trim()}
                    onClick={async () => {
                      const problem = await publishNote(noteDraft);
                      setNoteProblem(problem);
                      if (!problem) {
                        setNoteDraft("");
                        onNoteSaved?.();
                      }
                    }}
                  >
                    attach the note
                  </Button>
                </div>
              </div>
            ) : null}
            <p className="text-[12px] leading-relaxed text-muted">
              One bid per wallet on a job. This panel comes back only if the employer cancels and reposts.
            </p>
          </div>
        );
      }

      return (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
            <Field label="your price (WIF)">
              <input
                className={inputClass}
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder={formatWif(job.budget).replace(/,/g, "")}
                inputMode="decimal"
                disabled={busy}
              />
            </Field>
            <Field label="pitch">
              <input
                className={inputClass}
                value={pitch}
                onChange={(e) => setPitch(e.target.value)}
                placeholder="how you'll deliver, and when"
                disabled={busy}
              />
            </Field>
          </div>
          <p className="text-[12px] leading-relaxed text-warn">
            Bidding locks {formatWif(requiredBond)} WIF from your wallet — half your price — the moment the
            employer accepts. Deliver and you get it back with the payment. Abandon and you lose all of it.
          </p>

          {shortOfBond ? (
            <p className="border border-danger/40 bg-danger/5 p-3 text-[12px] leading-relaxed text-danger">
              Your wallet holds <span className="mono">{formatWif(myBalance)} WIF</span> and this bid needs a{" "}
              <span className="mono">{formatWif(requiredBond)} WIF</span> bond. The employer could not accept it,
              so the bid is blocked — top up{" "}
              <span className="mono">{formatWif(requiredBond - myBalance)} WIF</span> or bid a lower price.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {needsApproval ? (
              <Button
                disabled={busy || !price || shortOfBond}
                onClick={() => {
                  action.current = "approve";
                  writeContract({
                    address: WIF_ADDRESS,
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [ESCROW_ADDRESS, requiredBond],
                  });
                }}
              >
                {busy && action.current === "approve" ? "approving…" : `1 · approve ${formatWif(requiredBond)} WIF`}
              </Button>
            ) : null}

            <Button
              variant={needsApproval ? "ghost" : "primary"}
              disabled={busy || !price || needsApproval || shortOfBond}
              onClick={() => {
                /// Store the pitch only after the bid lands, and ask the chain which index
                /// it actually took — guessing from the current list races other bidders.
                pendingWrite.current = {
                  path: "/api/pitches",
                  body: async () => {
                    const fresh = client
                      ? ((await client.readContract({
                          address: ESCROW_ADDRESS,
                          abi: pactAbi,
                          functionName: "getBids",
                          args: [BigInt(jobId)],
                        })) as Bid[])
                      : [];
                    let index = -1;
                    fresh.forEach((b, i) => {
                      if (b.worker.toLowerCase() === address?.toLowerCase() && b.price === priceWei) index = i;
                    });
                    return {
                      jobId,
                      bidIndex: index < 0 ? bidCount : index,
                      worker: address,
                      pitch: pitch.trim() || "—",
                    };
                  },
                };
                call("bid", [BigInt(jobId), priceWei], "bid");
              }}
            >
              {busy && action.current === "bid" ? "bidding…" : needsApproval ? "2 · place bid" : "place bid"}
            </Button>
          </div>
        </div>
      );
    }

    /// A worker whose bid lost the auction gets a plain answer instead of the generic
    /// "work in progress" line meant for onlookers.
    if (myBid && !myBid.accepted) {
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] leading-relaxed text-muted">
            Your bid of {formatWif(myBid.price)} WIF was not selected — the employer assigned{" "}
            <a href={addressUrl(job.worker)} target="_blank" rel="noreferrer" className="text-text hover:text-accent">
              {shortAddress(job.worker)}
            </a>
            . Nothing was taken from your wallet; a bid only commits to a price.
          </p>
        </div>
      );
    }

    if (job.state === 2) {
      if (isWorker) {
        return (
          <div className="flex flex-col gap-4">
            <Field label="proof" hint="hashed and committed on-chain. deadlines are absolute.">
              <input className={inputClass} value={proof} onChange={(e) => setProof(e.target.value)} placeholder="https://…" />
            </Field>
            <p className="text-[12px] text-muted">
              Deliver before <Countdown target={job.deliveryDeadline} /> or the employer can take your whole bond.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !proof.trim()}
                onClick={() => {
                  const hash = keccak256(toHex(proof));
                  /// The deliverable is stored off-chain; the hash above is what makes it
                  /// verifiable. Published after the receipt so the chain can vouch for it.
                  pendingWrite.current = {
                    path: "/api/proofs",
                    body: { jobId, worker: address, proof, proofHash: hash },
                  };
                  call("submitDelivery", [BigInt(jobId), hash]);
                }}
              >
                {busy ? "submitting…" : "submit delivery"}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => call("abandonJob", [BigInt(jobId)])}>
                abandon — lose {formatWif(job.workerEscrow)} WIF
              </Button>
            </div>
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-muted">
            work in progress. deliverable due in <Countdown target={job.deliveryDeadline} />.
          </p>
          {/* If the worker never delivers, both stakes are stuck. After the deadline plus the
              grace period anyone may settle it as an abandonment, so the employer is not forced to
              buy a ticket to recover their own money. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => call("reclaimAssignment", [BigInt(jobId)])}>
              reclaim after the deadline
            </Button>
            <span className="text-[11px] leading-relaxed text-muted">
              opens once the delivery deadline passes, plus the escrow&apos;s grace. The bond goes to the
              employer and the price is refunded.
            </span>
          </div>
        </div>
      );
    }

    if (job.state === 3) {
      if (isEmployer) {
        return (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-muted">
              Proof committed. Approve to release, or file a ticket. If you do nothing for 14 days the money
              releases to the worker anyway.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => call("approveDelivery", [BigInt(jobId)])}>
                {busy ? "releasing…" : `approve — pay ${formatWif(job.price)}`}
              </Button>
            </div>
            <Details
              onFile={(r) => {
                const reasonHash = keccak256(toHex(r));
                pendingWrite.current = {
                  path: "/api/disputes",
                  body: { jobId, filer: address, reason: r.trim(), reasonHash },
                };
                call("raiseDispute", [BigInt(jobId), reasonHash]);
              }}
              busy={busy}
              side="employer"
              job={job}
              allowance={(allowance as bigint | undefined) ?? 0n}
              onApprove={(fee) =>
                writeContract({
                  address: WIF_ADDRESS,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [ESCROW_ADDRESS, fee],
                })
              }
              refetchAllowance={refetchAllowance}
            />
          </div>
        );
      }
      if (isWorker) {
        return (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-muted">
              Delivered. Money releases <Countdown target={job.autoReleaseAt} /> if the employer stays silent, or
              you can file a ticket now.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => call("releaseExpired", [BigInt(jobId)])}>
                release (only after the window)
              </Button>
            </div>
            <Details
              onFile={(r) => {
                const reasonHash = keccak256(toHex(r));
                pendingWrite.current = {
                  path: "/api/disputes",
                  body: { jobId, filer: address, reason: r.trim(), reasonHash },
                };
                call("raiseDispute", [BigInt(jobId), reasonHash]);
              }}
              busy={busy}
              side="worker"
              job={job}
            />
          </div>
        );
      }
      return <p className="text-[13px] text-muted">delivered, awaiting the employer. auto-releases in <Countdown target={job.autoReleaseAt} />.</p>;
    }

    if (job.state === 4) {
      return (
        <p className="text-[13px] text-muted">
          Ticket open since the freeze began. The resolver rules; neither party can move the escrow until then.
        </p>
      );
    }

    return (
      <p className="text-[13px] text-muted">
        This job is {STATE_LABEL[job.state]}.{" "}
        {((claimable as bigint | undefined) ?? 0n) > 0n
          ? "Payouts are pull-based. Record the finished work on your account page first — that unlocks the claim in the header."
          : "Nothing is left to claim from this job for this wallet."}
      </p>
    );
  }, [isConnected, job, isEmployer, isWorker, price, pitch, proof, busy, address, jobId, bidCount, call, allowance, writeContract, alreadyBid, myBid, client, claimable, myBalance, refetchAllowance, bids, pitches, noteDraft, noteProblem, publishNote, onNoteSaved]);

  /// Nothing that produces a record may happen before the wallet owns a name. Placed after every
  /// hook so the early return cannot change the hook order.
  if (isConnected && nameReady && !registered) {
    return <UsernameRequired what="bid on, accept or work a job" />;
  }

  return (
    <>
      <Panel className="mt-5 p-5">
        <SectionLabel>what happens now</SectionLabel>
        <div className="mt-3">{body}</div>
        {error ? (
          <div className="mt-4 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
            {friendlyError(error.message)}
            <button onClick={reset} className="ml-2 underline">
              dismiss
            </button>
          </div>
        ) : null}
        {hash ? (
          <a href={txUrl(hash, TAB_LOGS)} target="_blank" rel="noreferrer" className="mono mt-3 inline-block text-[10px] text-accent hover:underline">
            view transaction →
          </a>
        ) : null}
      </Panel>

      {/* Record then claim, right where the settled job is. Buried in the header, nobody finds it. */}
      {isConnected && address && job.state === 5 && (isEmployer || isWorker) ? (
        <div className="mt-5">
          <SettledActions jobId={jobId} address={address} />
        </div>
      ) : null}
    </>
  );
}

function Details({
  onFile,
  busy,
  side,
  job,
  allowance = 0n,
  onApprove,
  refetchAllowance,
}: {
  onFile: (reason: string) => void;
  busy: boolean;
  side: "employer" | "worker";
  job: Job;
  allowance?: bigint;
  onApprove?: (fee: bigint) => void;
  refetchAllowance?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);

  const fee = job.price / 10n;

  /// An employer pays the filing fee as new WIF, which needs an allowance first.
  /// A worker's fee comes out of their bond, so they approve nothing here.
  const needsApproval = side === "employer" && allowance < fee;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mono self-start text-[10px] uppercase tracking-[0.14em] text-danger hover:underline">
        file a ticket instead →
      </button>
    );
  }

  return (
    <div className="border border-danger/30 bg-danger/[0.03] p-4">
      <Field label="why" hint="hashed on-chain. it is the whole record the resolver sees.">
        <textarea
          className={`${inputClass} min-h-[70px] resize-y`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={side === "employer" ? "the deliverable does not meet the stated criteria" : "delivered in full, employer will not approve"}
        />
      </Field>
      <p className="mt-3 text-[12px] leading-relaxed text-danger">
        Filing costs {formatWif(fee)} WIF (10% of the price) and freezes both escrows.{" "}
        {side === "employer"
          ? "You pay it as new WIF, so it never comes out of the worker's payment."
          : "It comes out of your bond, so you don't need spare WIF to file."}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {needsApproval ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onApprove?.(fee);
              setTimeout(() => refetchAllowance?.(), 1500);
            }}
          >
            {busy ? "approving…" : `1 · approve ${formatWif(fee)} WIF`}
          </Button>
        ) : null}

        <Button
          variant="danger"
          disabled={busy || !reason.trim() || needsApproval}
          onClick={() => onFile(reason)}
        >
          {busy ? "filing…" : needsApproval ? "2 · file ticket" : `file ticket — ${formatWif(fee)} WIF`}
        </Button>

        <Button variant="ghost" onClick={() => setOpen(false)}>
          cancel
        </Button>
      </div>

      {needsApproval ? (
        <p className="mono mt-2 text-[10px] leading-relaxed text-muted">
          current allowance: {formatWif(allowance)} WIF · the fee is a second transaction
        </p>
      ) : null}
    </div>
  );
}

function BidList({
  job,
  jobId,
  bids,
  pitches,
  isEmployer,
}: {
  job: Job;
  jobId: number;
  bids: Bid[];
  pitches: { bidIndex: number; worker: string; pitch: string }[];
  isEmployer: boolean;
}) {
  const { address } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const [chosen, setChosen] = useState<number | null>(null);

  /// acceptBid pulls the worker's bond in the same transaction. A bid from a wallet that
  /// holds no WIF — or never approved — cannot be accepted at all, and the revert names
  /// the worker, which reads to the employer like a fault in their own wallet. Check ahead.
  const { data: purses } = useReadContracts({
    contracts: bids.flatMap((bid) => [
      { address: WIF_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [bid.worker] },
      { address: WIF_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [bid.worker, ESCROW_ADDRESS] },
    ]),
    query: { enabled: bids.length > 0, refetchInterval: 6000 },
  });

  /// Undefined until the reads land — treated as "fundable" so the button is never
  /// disabled by a pending query.
  const canFund = (i: number) => {
    const bond = bids[i].price / 2n;
    const balance = purses?.[i * 2]?.result as bigint | undefined;
    const allowance = purses?.[i * 2 + 1]?.result as bigint | undefined;
    if (balance === undefined || allowance === undefined) return { known: false, ok: true, balance: 0n, bond };
    return { known: true, ok: balance >= bond && allowance >= bond, balance, bond };
  };

  const busy = isPending || confirming;
  /// Accepting one bid closes the auction on-chain. Until the job refetch catches up the
  /// other buttons must already be dead, or the employer can fire a second one and take
  /// a pointless revert.
  const decided = job.state !== 1 || isSuccess;
  const pitchFor = (i: number) => pitches.find((p) => p.bidIndex === i)?.pitch;

  /// A rejected signature must hand the buttons back — `chosen` is only a guess until
  /// the receipt says otherwise.
  useEffect(() => {
    if (error) setChosen(null);
  }, [error]);

  if (bids.length === 0) {
    return (
      <Panel className="mt-5 p-5">
        <SectionLabel>bids</SectionLabel>
        <p className="mt-3 text-[13px] text-muted">none yet.</p>
      </Panel>
    );
  }

  return (
    <Panel className="mt-5">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <SectionLabel>bids · {bids.length}</SectionLabel>
        {decided && job.state !== 1 ? <span className="mono text-[9px] uppercase tracking-[0.14em] text-muted">closed</span> : null}
      </div>
      <div className="divide-y divide-line">
        {bids.map((bid, i) => {
          const isAccepted = bid.accepted || (isSuccess && chosen === i);
          const isRejected = decided && !isAccepted;
          const isMine = bid.worker.toLowerCase() === address?.toLowerCase();
          const funds = canFund(i);

          return (
            <div
              key={i}
              className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${isRejected ? "opacity-60" : ""}`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AddressName address={bid.worker} />
                  {isMine ? <Badge tone="accent">you</Badge> : null}
                  {isAccepted ? <Badge tone="accent">selected</Badge> : null}
                  {isRejected ? <Badge tone="muted">not selected</Badge> : null}
                  {!decided && funds.known && !funds.ok ? <Badge tone="danger">cannot fund bond</Badge> : null}
                </div>
                <span className="text-[12px] text-muted">{pitchFor(i) ?? "—"}</span>
                {!decided && funds.known && !funds.ok ? (
                  <span className="text-[11px] leading-relaxed text-danger break-words">
                    This wallet holds {formatWif(funds.balance)} WIF and the bond is {formatWif(funds.bond)}. Accepting
                    would revert — the bidder has to top up and approve the bond first.
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <span className={`mono text-[13px] ${isRejected ? "text-muted line-through" : "text-accent"}`}>
                    {formatWif(bid.price)}
                  </span>
                  <span className="mono text-[9px] text-muted">
                    bond {formatWif(bid.price / 2n)} · {formatUsd(bid.price)}
                  </span>
                </div>
                {isEmployer && !decided && !isAccepted ? (
                  <Button
                    disabled={busy || chosen !== null || !funds.ok}
                    onClick={() => {
                      setChosen(i);
                      writeContract({
                        address: ESCROW_ADDRESS,
                        abi: pactAbi,
                        functionName: "acceptBid",
                        args: [BigInt(jobId), BigInt(i)],
                      } as never);
                    }}
                  >
                    {busy && chosen === i ? "accepting…" : "accept"}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {isSuccess ? (
        <div className="mono flex items-center gap-3 border-t border-accent/30 bg-accent/[0.05] px-5 py-3 text-[10px] text-accent">
          assigned. every other bid was closed — nothing was taken from their wallets.
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 border-t border-danger/40 bg-danger/5 px-5 py-3 text-[11px] text-danger">
          {friendlyError(error.message)}
          <button onClick={reset} className="underline">
            dismiss
          </button>
        </div>
      ) : null}
    </Panel>
  );
}
