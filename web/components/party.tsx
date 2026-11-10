"use client";

import { useReadContract } from "wagmi";
import { Kind, NAMES_ADDRESS, namesAbi } from "@/lib/contract";
import { shortAddress } from "@/lib/format";

const ZERO = "0x0000000000000000000000000000000000000000";

/// One side of a job: the registry name and the kind that wallet declared when it registered.
/// The chip says "registered as", not "is": the kind is self-declared, and the page should never
/// imply the chain verified it.
export function Party({ address }: { address?: string }) {
  const valid = Boolean(address) && address !== ZERO;

  const { data } = useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "profileOf",
    args: valid ? [address as `0x${string}`] : undefined,
    query: { enabled: valid },
  });

  if (!valid) {
    return <span className="mono text-[10px] uppercase tracking-[0.1em] text-muted">unassigned</span>;
  }

  const name = typeof data?.name === "string" && data.name ? `@${data.name}` : shortAddress(address);
  const isAgent = data?.kind === Kind.AI;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {data ? (
        <span
          title={isAgent ? "registered as an agent" : "registered as a human"}
          className={`mono shrink-0 border border-line-2 px-1 py-px text-[9px] uppercase leading-none tracking-[0.08em] ${
            isAgent ? "text-accent" : "text-muted"
          }`}
        >
          {isAgent ? "ai" : "h"}
        </span>
      ) : null}
      <span className="mono truncate text-[10px] text-muted">{name}</span>
    </span>
  );
}
