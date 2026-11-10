"use client";

import { useEffect, useState } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ESCROW_ADDRESS, NAMES_ADDRESS, namesAbi, pactAbi } from "@/lib/contract";
import { useClaimable } from "@/lib/hooks";
import { useIsRecorded, useUnrecorded } from "@/lib/names";
import { useSessionSignIn } from "@/lib/use-sign-in";
import { friendlyError } from "@/lib/errors";
import { formatWif } from "@/lib/format";
import { Button, Panel, SectionLabel } from "@/components/ui";

/// The two steps that turn a settled job into money, in one place on the job page:
/// record the finished work, then claim. Recording is what unlocks the claim.
export function SettledActions({ jobId, address }: { jobId: number; address: `0x${string}` }) {
  const { data: recorded, refetch: refetchRecorded } = useIsRecorded(jobId);
  const { data: unrecorded, refetch: refetchUnrecorded } = useUnrecorded(address);
  const { data: claimable, refetch: refetchClaimable } = useClaimable(address);
  const { signIn } = useSessionSignIn();

  const [action, setAction] = useState<"record" | "claim" | null>(null);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const busy = isPending || confirming;

  useEffect(() => {
    if (!isSuccess || !action) return;

    void (async () => {
      if (action === "record") {
        // Text is destroyed only once the chain holds the record.
        const retire = async () =>
          fetch("/api/jobs/retire", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId }),
          });

        let res = await retire();
        if (res.status === 401) {
          if (await signIn()) res = await retire();
        }
      }

      reset();
      setAction(null);
      await Promise.all([refetchRecorded(), refetchUnrecorded(), refetchClaimable()]);
    })();
  }, [isSuccess, action, jobId, reset, refetchRecorded, refetchUnrecorded, refetchClaimable, signIn]);

  const claimValue = (claimable as bigint | undefined) ?? 0n;
  const isRecorded = recorded === true;
  const locked = Number(unrecorded ?? 0) > 0;

  return (
    <Panel>
      <SectionLabel>settled · claim your balance</SectionLabel>

      {!isRecorded ? (
        <>
          <p className="mt-3 text-[13px] text-muted">
            This job finished and the money is credited, but the claim is locked until the work is
            written into the public record. Recording stores the terms hash, the proof hash, the
            outcome and the amounts — and deletes the job text.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              disabled={busy}
              onClick={() => {
                setAction("record");
                writeContract({
                  address: NAMES_ADDRESS,
                  abi: namesAbi,
                  functionName: "record",
                  args: [BigInt(jobId)],
                });
              }}
            >
              {busy && action === "record" ? "recording…" : "record the finished work"}
            </Button>
            <span className="mono text-[10px] uppercase tracking-[0.1em] text-muted">
              one signature · either party can do it
            </span>
          </div>
        </>
      ) : claimValue > 0n && !locked ? (
        <>
          <p className="mt-3 text-[13px] text-muted">
            Recorded. Your balance is waiting — claim pays everything you are owed, across every job.
          </p>
          <div className="mt-4">
            <Button
              disabled={busy}
              onClick={() => {
                setAction("claim");
                writeContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "claim" });
              }}
            >
              {busy && action === "claim" ? "claiming…" : `claim ${formatWif(claimValue)} WIF`}
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-3 text-[13px] text-muted">
          {claimValue > 0n
            ? "Recorded. Another settled job still needs a record before this claim can go through — open your account page to finish it."
            : "Recorded. Nothing is left to claim from this job for this wallet."}
        </p>
      )}

      {error ? <p className="mt-3 text-[11px] text-danger">{friendlyError(error.message)}</p> : null}
    </Panel>
  );
}
