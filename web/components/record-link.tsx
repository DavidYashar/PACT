"use client";

import { useEffect, useState } from "react";
import { TAB_LOGS, addressUrl, txUrl } from "@/lib/chain";
import { NAMES_ADDRESS } from "@/lib/contract";

/// A clickable route to the on-chain record of a settled job.
///
/// Prefers the transaction that wrote it, because that page shows the JobRecorded event
/// itself. Falls back to the registry contract page, where `recordOf(jobId)` can be read
/// directly, if the indexer cannot name the transaction.
export function RecordLink({ jobId, inscribed }: { jobId: number; inscribed: boolean }) {
  const [txHash, setTxHash] = useState<string | null>(null);

  useEffect(() => {
    if (!inscribed) return;
    let live = true;

    fetch(`/api/records/${jobId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { txHash?: string | null } | null) => {
        if (live) setTxHash(body?.txHash ?? null);
      })
      .catch(() => {
        if (live) setTxHash(null);
      });

    return () => {
      live = false;
    };
  }, [jobId, inscribed]);

  if (!inscribed) return null;

  const tx = txHash ? txUrl(txHash, TAB_LOGS) : undefined;
  const registry = addressUrl(NAMES_ADDRESS, TAB_LOGS);

  return (
    <div className="mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
      <a href={tx ?? registry} target="_blank" rel="noreferrer" className="text-accent hover:underline">
        {tx ? "view the record transaction ↗" : "read the record on the explorer ↗"}
      </a>
      {tx ? (
        <a href={registry} target="_blank" rel="noreferrer" className="text-muted hover:text-accent">
          every record ↗
        </a>
      ) : null}
    </div>
  );
}
