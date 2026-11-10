"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseEventLogs } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ESCROW_ADDRESS, WIF_ADDRESS, erc20Abi, pactAbi } from "@/lib/contract";
import { parseWif, formatWif, formatUsd, inputToUnix, toLocalInput } from "@/lib/format";
import { useWifBalance } from "@/lib/hooks";
import { useIsRegistered, useMinCountedPrice } from "@/lib/names";
import { UsernameRequired } from "@/components/username-required";
import { termsDigest } from "@/lib/terms";
import { Button, Field, inputClass, Panel, PanelHeader } from "@/components/ui";

const CATEGORIES = ["design", "development", "writing", "video", "research", "marketing", "other"];
const PRESETS = ["10000", "50000", "250000", "1000000"];

type PendingPost = {
  termsHash: `0x${string}`;
  title: string;
  description: string;
  criteria: string;
  proofSpec: string;
  category: string;
};

export default function NewJobPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { ready: nameReady, registered } = useIsRegistered(address);
  const countedAt = useMinCountedPrice();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [proofSpec, setProofSpec] = useState("");
  const [category, setCategory] = useState("development");
  const [expectedDigest, setExpectedDigest] = useState("");
  /// The silence window belongs to the job, because a worker prices it: an hour to be paid
  /// automatically is a different job from a fortnight. 18 hours is the default because it covers
  /// a night of not looking at a screen.
  const [autoReleaseHours, setAutoReleaseHours] = useState("18");
  const [budget, setBudget] = useState("50000");
  const [bidDeadline, setBidDeadline] = useState(toLocalInput(86400));
  const [deliveryDeadline, setDeliveryDeadline] = useState(toLocalInput(86400 * 7));
  const [stage, setStage] = useState<"form" | "posted">("form");

  const pendingPost = useRef<PendingPost | null>(null);

  /// Allowances only change by transaction, so this has to be re-read rather than
  /// trusted from the first load — otherwise the button never leaves the approve step.
  const {
    data: allowance,
    refetch: refetchAllowance,
  } = useReadContract({
    address: WIF_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, ESCROW_ADDRESS] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 4_000 },
  });

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { data: receipt, isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const action = useRef<"approve" | "post" | null>(null);

  /// postJob pulls the whole budget in the same transaction. A wallet holding less than
  /// that cannot post at all, so say so before the wallet has to fail for us.
  const { data: wifBalance } = useWifBalance(address);
  const balance = (wifBalance as bigint | undefined) ?? 0n;

  const budgetWei = parseWif(budget);
  const allowanceValue = (allowance as bigint | undefined) ?? 0n;
  const needsApproval = budgetWei > 0n && allowanceValue < budgetWei;
  const shortOfBudget = budgetWei > 0n && balance < budgetWei;

  /// Hash the exact strings we intend to publish, trimmed — the server re-hashes what
  /// it receives and rejects anything that does not reproduce the on-chain value.
  const expectedProofHash = expectedDigest.trim();
  const committed = /^0x[0-9a-fA-F]{64}$/.test(expectedProofHash) ? (expectedProofHash as `0x${string}`) : null;
  const terms = {
    title: title.trim(),
    description: description.trim(),
    criteria: criteria.trim(),
    proofSpec: proofSpec.trim(),
    category,
    /// Only included when filled in, so a job that does not commit to a digest hashes exactly as
    /// it did before this field existed.
    ...(committed ? { expectedProofHash: committed } : {}),
  };

  const termsHash = termsDigest(terms);

  const canPost =
    isConnected &&
    title.trim().length > 2 &&
    description.trim().length > 10 &&
    criteria.trim().length > 5 &&
    proofSpec.trim().length > 3 &&
    budgetWei > 0n &&
    !shortOfBudget &&
    inputToUnix(deliveryDeadline) > inputToUnix(bidDeadline) &&
    inputToUnix(bidDeadline) > Math.floor(Date.now() / 1000);

  /// React to whichever transaction just landed.
  useEffect(() => {
    if (!isSuccess || !receipt) return;

    if (action.current === "approve") {
      action.current = null;
      refetchAllowance();
      return;
    }

    if (action.current !== "post") return;
    action.current = null;

    const pending = pendingPost.current;
    const [posted] = parseEventLogs({ abi: pactAbi, logs: receipt.logs, eventName: "JobPosted" });
    const jobId = posted ? Number(posted.args.jobId) : undefined;

    setStage("posted");

    if (!jobId) {
      router.push("/jobs");
      return;
    }

    /// Content is written after the event tells us the real id. Best-effort: the job
    /// already exists on-chain, so a failed write only costs the readable terms.
    if (pending) {
      fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, employer: address, ...pending }),
      })
        .catch(() => undefined)
        .finally(() => router.push(`/job/${jobId}`));
    } else {
      router.push(`/job/${jobId}`);
    }
  }, [isSuccess, receipt, refetchAllowance, router, address]);

  function approve() {
    action.current = "approve";
    writeContract({
      address: WIF_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [ESCROW_ADDRESS, budgetWei],
    });
  }

  function post() {
    action.current = "post";
    pendingPost.current = { termsHash, ...terms };

    writeContract({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "postJob",
      args: [
        termsHash,
        budgetWei,
        BigInt(inputToUnix(bidDeadline)),
        BigInt(inputToUnix(deliveryDeadline)),
        BigInt(autoReleaseHours) * 3600n,
      ],
    });
  }

  if (stage === "posted") {
    return (
      <div className="mx-auto max-w-3xl px-5 py-24 text-center">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-accent">posted</div>
        <h1 className="mt-3 text-2xl">the budget is locked.</h1>
        <p className="mt-3 text-[13px] text-muted">Opening the job…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="claim-tight text-text">post a job</h1>
      <p className="mt-1.5 text-[13px] text-muted">
        The terms you write here are hashed and locked on-chain. Nobody — including you — can change the
        criteria after a bid is accepted.
      </p>

      {isConnected && nameReady && !registered ? <UsernameRequired what="post a job" /> : null}

      <Panel className="mt-8">
        <PanelHeader
          title="the terms"
          note="hashed and locked on chain. this is exactly what a worker prices, and nobody can change it after a bid is accepted."
        />
        <div className="flex flex-col gap-6 p-6">
        <Field label="what do you need" hint="one line. this is the title workers see.">
          <input
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="write and publish 10 articles on L2 fees"
          />
        </Field>

        <Field label="detail" hint="scope, context, anything a worker needs to quote a price.">
          <textarea
            className={`${inputClass} min-h-[110px] resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="long form. 1,200 words each. topic list attached. publishing handled by you."
          />
        </Field>

        <Field
          label="acceptance criteria"
          hint="checkable statements only. '1000 real followers' is not checkable — '1000 followers on a public account with a 30-day history' is."
        >
          <textarea
            className={`${inputClass} min-h-[90px] resize-y`}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="10 published URLs, each over 1,200 words, all live on the domain at review time."
          />
        </Field>

        <Field label="what counts as proof" hint="the worker submits a hash of exactly this.">
          <input
            className={inputClass}
            value={proofSpec}
            onChange={(e) => setProofSpec(e.target.value)}
            placeholder="a URL to the published post, plus a screenshot of the CMS"
          />
        </Field>

        <Field
          label="expected digest (optional)"
          hint="name the exact deliverable you will accept and this job needs no judgment: a delivery that hashes to this value can be approved on sight, and anything else is not the artefact you asked for."
        >
          <input
            className={`${inputClass} font-mono text-[12px]`}
            value={expectedDigest}
            onChange={(e) => setExpectedDigest(e.target.value)}
            placeholder="0x… (keccak256 of the exact file or line you want back)"
          />
          {expectedDigest.trim() && !committed ? (
            <p className="mt-2 text-[11px] text-warn">that is not a 32-byte hex digest, so it will not be committed</p>
          ) : null}
        </Field>

        <Field
          label="release if you go silent (hours)"
          hint="how long after delivery you have to approve before anyone can pay the worker automatically. a worker prices this, so it is worth naming honestly."
        >
          <input
            className={inputClass}
            value={autoReleaseHours}
            onChange={(e) => setAutoReleaseHours(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="18"
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="category">
            <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="bg-panel">
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="budget (WIF)"
            hint={budgetWei > 0n ? `${formatWif(budgetWei)} WIF · ${formatUsd(budgetWei)}` : undefined}
          >
            <input
              className={inputClass}
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => setBudget(p)}
              className={`mono border px-3 py-1 text-[10px] tracking-[0.1em] transition-colors ${
                budget === p ? "border-accent text-accent" : "border-line-2 text-muted hover:text-text"
              }`}
            >
              {Number(p).toLocaleString()}
            </button>
          ))}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="bids close">
            <input
              type="datetime-local"
              className={inputClass}
              value={bidDeadline}
              onChange={(e) => setBidDeadline(e.target.value)}
            />
          </Field>
          <Field label="deliver by">
            <input
              type="datetime-local"
              className={inputClass}
              value={deliveryDeadline}
              onChange={(e) => setDeliveryDeadline(e.target.value)}
            />
          </Field>
        </div>
        </div>
      </Panel>

      <div className="mt-5 border border-line bg-panel p-5">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">terms hash</div>
        <div className="mono mt-2 break-all text-[11px] text-muted">{termsHash}</div>
      </div>

      {/* What this job commits, in the same four-figure form the boards use. */}
      <div className="mt-5 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
        <Figure label="you lock" value={`${formatWif(budgetWei)} WIF`} sub={formatUsd(budgetWei)} />
        <Figure label="worker bonds" value={`${formatWif(budgetWei / 2n)} WIF`} sub="50% of the price" />
        <Figure label="fee on release" value={`${formatWif(budgetWei / 20n)} WIF`} sub="5% of the price" />
        <Figure label="if you go silent" value={`${autoReleaseHours || "0"} h`} sub="before auto-release" />
      </div>

      {/* A job under the registry's floor still settles and pays, in full. What it does not do is
          count towards either side's record, and finding that out after the fact reads as a bug. */}
      {countedAt !== undefined && budgetWei > 0n && budgetWei < countedAt ? (
        <div className="mt-5 border border-line bg-panel p-5">
          <p className="text-[12px] leading-relaxed text-muted">
            The registry counts a settled job at {formatWif(countedAt)} WIF and above. At{" "}
            {formatWif(budgetWei)} WIF this one still settles and pays in full, but it moves no
            reputation counter and enters neither party&apos;s history.
          </p>
        </div>
      ) : null}

      <div className="mt-5 border border-warn/30 bg-warn/[0.04] p-5">
        <p className="text-[13px] leading-relaxed text-warn">
          You are about to lock {formatWif(budgetWei)} WIF ({formatUsd(budgetWei)}). If a worker delivers and
          you do not respond for {autoReleaseHours || "0"} hours, the money releases without you. If you file a
          ticket and lose, you pay 10% of the price and still keep the work.
        </p>
      </div>

      {error ? (
        <div className="mt-4 border border-danger/40 bg-danger/5 p-4 text-[12px] text-danger">
          {error.message.split("\n")[0]}
          <button onClick={reset} className="ml-2 underline">
            dismiss
          </button>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {!isConnected ? (
          <span className="mono text-[11px] text-muted">connect a wallet to post</span>
        ) : shortOfBudget ? (
          <div className="w-full border border-danger/40 bg-danger/5 p-4 text-[12px] leading-relaxed text-danger">
            Your wallet holds <span className="mono">{formatWif(balance)} WIF</span> and this job locks{" "}
            <span className="mono">{formatWif(budgetWei)} WIF</span>. Posting transfers the whole budget into
            escrow, so it cannot go through — top up{" "}
            <span className="mono">{formatWif(budgetWei - balance)} WIF</span> first, or lower the budget.
          </div>
        ) : (
          <>
            <Step done={!needsApproval} active={needsApproval} number="1">
              <Button onClick={approve} disabled={!needsApproval || isPending || confirming}>
                {isPending && action.current === "approve"
                  ? "approving…"
                  : needsApproval
                    ? `approve ${formatWif(budgetWei)} WIF`
                    : "approved"}
              </Button>
            </Step>

            <Step done={false} active={!needsApproval} number="2">
              <Button
                onClick={post}
                disabled={!canPost || needsApproval || isPending || confirming}
                variant={needsApproval ? "ghost" : "primary"}
              >
                {isPending && action.current === "post" ? "posting…" : "lock budget and post"}
              </Button>
            </Step>

            <span className="mono text-[10px] text-muted">
              {needsApproval ? "two signatures: approve, then post" : canPost ? "ready" : "fill the fields above"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1.5 bg-bg px-4 py-4">
      <span className="label">{label}</span>
      <span className="mono text-[18px] leading-none tabular-nums text-text">{value}</span>
      {sub ? <span className="mono text-[9px] leading-none text-muted">{sub}</span> : null}
    </div>
  );
}

function Step({
  children,
  number,
  active,
  done,
}: {
  children: React.ReactNode;
  number: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <span className={`flex items-center gap-2 ${active ? "" : "opacity-60"}`}>
      <span
        className={`mono flex h-5 w-5 items-center justify-center border text-[9px] ${
          done ? "border-accent text-accent" : active ? "border-text text-text" : "border-line-2 text-muted"
        }`}
      >
        {done ? "✓" : number}
      </span>
      {children}
    </span>
  );
}
