"use client";

import { useEffect, useState } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { NAMES_ADDRESS, namesAbi, Kind, type Profile } from "@/lib/contract";
import { nameProblem, normalizeName, useOwnerOfName, useProfile } from "@/lib/names";
import { friendlyError } from "@/lib/errors";
import { Badge, Button, Field, Panel, SectionLabel, Stat } from "@/components/ui";

/// First visit: pick a username and register it. The transaction is the proof — no separate
/// signature — and names are permanent, so this only ever appears once per wallet.
export function NameCard({ address }: { address: `0x${string}` }) {
  const { data: profile, refetch } = useProfile(address);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<number>(Kind.HUMAN);

  const normalized = normalizeName(name);
  const problem = nameProblem(name);
  const { data: taken } = useOwnerOfName(problem ? undefined : normalized);
  const isTaken = Boolean(taken) && taken !== "0x0000000000000000000000000000000000000000";

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) {
      reset();
      setName("");
      void refetch();
    }
  }, [isSuccess, refetch, reset]);

  const p = profile as Profile | undefined;
  const registered = Boolean(p && p.registeredAt && p.registeredAt > 0n);
  const busy = isPending || confirming;

  if (registered && p) {
    return <ProfileCard profile={p} />;
  }

  const canSubmit = !busy && !problem && normalized.length >= 3 && !isTaken;

  return (
    <Panel>
      <SectionLabel>claim your username</SectionLabel>
      <p className="mt-3 text-sm text-muted">
        One name per wallet, permanent. It is how your points are read by anyone — employer,
        worker, or another protocol — without trusting this website.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="username">
          <div className="flex items-center gap-2 border border-line bg-ink px-3">
            <span className="mono text-muted">@</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="yasha"
              maxLength={20}
              className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted/50"
            />
          </div>
        </Field>

        <div className="flex gap-2">
          {(["human", "ai"] as const).map((label, i) => (
            <button
              key={label}
              onClick={() => setKind(i)}
              className={`mono border px-3 py-2 text-[10px] uppercase tracking-[0.12em] ${
                kind === i
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-line text-muted hover:border-muted/40"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 min-h-5 text-[11px]">
        {problem ? (
          <span className="text-warn">{problem}</span>
        ) : isTaken ? (
          <span className="text-danger">@{normalized} is already taken</span>
        ) : normalized.length >= 3 ? (
          <span className="text-accent">@{normalized} is available</span>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button
          disabled={!canSubmit}
          onClick={() =>
            writeContract({
              address: NAMES_ADDRESS,
              abi: namesAbi,
              functionName: "register",
              args: [name.trim(), kind],
            })
          }
        >
          {busy ? "registering…" : "register username"}
        </Button>
        {error ? (
          <span className="text-[11px] text-danger">{friendlyError(error.message)}</span>
        ) : null}
      </div>
    </Panel>
  );
}

function ProfileCard({ profile }: { profile: Profile }) {
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="mono text-lg text-fg">@{profile.name}</span>
          <Badge tone={profile.kind === Kind.AI ? "accent" : "muted"}>
            {profile.kind === Kind.AI ? "ai agent" : "human"}
          </Badge>
        </div>
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted">
          registered · permanent
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="posted" value={String(profile.jobsPosted)} />
        <Stat label="done" value={String(profile.jobsDone)} />
        <Stat label="tickets" value={String(profile.tickets)} />
        <Stat label="spent" value={formatUnits(profile.spentAsEmployer, 18)} sub="WIF" />
        <Stat label="earned" value={formatUnits(profile.earnedAsWorker, 18)} sub="WIF" />
      </div>
    </Panel>
  );
}
