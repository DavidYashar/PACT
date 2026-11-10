"use client";

import { useEffect, useMemo, useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { NAMES_ADDRESS, namesAbi } from "@/lib/contract";
import { useAllJobs } from "@/lib/hooks";
import { useUnrecorded } from "@/lib/names";
import { useSessionSignIn } from "@/lib/use-sign-in";
import { friendlyError } from "@/lib/errors";
import { Button, Panel, SectionLabel } from "@/components/ui";

/// Settled jobs this wallet has not inscribed yet. Recording is what unlocks the money: the
/// escrow pays a wallet's whole balance in one transfer, so the claim stays blocked until every
/// settled job is on the record. Either party may pay to record — one record unlocks both.
export function RecordPanel({ address, onRecorded }: { address: `0x${string}`; onRecorded?: () => void }) {
  const { jobs } = useAllJobs();
  const { data: unrecorded } = useUnrecorded(address);
  const { signIn } = useSessionSignIn();

  const [activeId, setActiveId] = useState(0);
  const lower = address.toLowerCase();

  const mine = useMemo(
    () =>
      jobs.filter(
        ({ job }) =>
          job.state === 5 &&
          (job.employer.toLowerCase() === lower || job.worker.toLowerCase() === lower),
      ),
    [jobs, lower],
  );

  const reads = useReadContracts({
    contracts: mine.map(({ id }) => ({
      address: NAMES_ADDRESS,
      abi: namesAbi,
      functionName: "recorded",
      args: [BigInt(id)] as const,
    })),
    query: { enabled: mine.length > 0, refetchInterval: 4000 },
  });

  const pending = mine.filter((_, i) => (reads.data?.[i]?.result as boolean | undefined) !== true);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!isSuccess || !activeId) return;

    void (async () => {
      // The text is destroyed only after the chain holds the record. A missing session is not
      // fatal here — the chain already has everything, so a failed retire can be retried later.
      const retire = async () =>
        fetch("/api/jobs/retire", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: activeId }),
        });

      let res = await retire();
      if (res.status === 401) {
        if (await signIn()) res = await retire();
      }

      reset();
      setActiveId(0);
      await reads.refetch();
      onRecorded?.();
    })();
  }, [isSuccess, activeId, reset, reads, signIn, onRecorded]);

  if (pending.length === 0) return null;

  const busy = isPending || confirming;
  const blocked = Number(unrecorded ?? 0);

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>record the finished work</SectionLabel>
        {blocked > 0 ? (
          <span className="mono text-[10px] uppercase tracking-[0.12em] text-warn">
            claims locked · {blocked} unrecorded
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-sm text-muted">
        A settled job becomes a permanent entry in your history: the terms hash, the proof hash,
        the outcome and the amounts. Signing this is what unlocks the payout — the job text is
        deleted once it is on the chain.
      </p>

      <div className="mt-4 divide-y divide-line border border-line">
        {pending.map(({ id, job }) => {
          const iAmWorker = job.worker.toLowerCase() === lower;
          return (
            <div key={id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
              <div className="flex flex-col gap-1">
                <span className="mono text-sm">
                  job #{id} · {iAmWorker ? "as worker" : "as employer"}
                </span>
                <span className="mono text-[10px] uppercase tracking-[0.1em] text-muted">
                  price {formatUnits(job.price, 18)} WIF ·{" "}
                  {job.workerWon ? "settled to worker" : "settled to employer"}
                </span>
              </div>
              <Button
                disabled={busy}
                onClick={() => {
                  setActiveId(id);
                  writeContract({
                    address: NAMES_ADDRESS,
                    abi: namesAbi,
                    functionName: "record",
                    args: [BigInt(id)],
                  });
                }}
              >
                {busy && activeId === id ? "recording…" : "record"}
              </Button>
            </div>
          );
        })}
      </div>

      {error ? (
        <p className="mt-3 text-[11px] text-danger">{friendlyError(error.message)}</p>
      ) : null}
    </Panel>
  );
}
