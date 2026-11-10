"use client";

import Link from "next/link";
import { useReadContract } from "wagmi";
import { NAMES_ADDRESS, namesAbi } from "@/lib/contract";
import { addressUrl } from "@/lib/chain";
import { shortAddress } from "@/lib/format";

/// A wallet's username, resolved from the registry, falling back to the address.
///
/// Links to the explorer so the full address and the wallet's whole transaction history are
/// one click away — the name is the label, the chain is still the evidence.
export function AddressName({
  address,
  className = "",
  showAddress = true,
}: {
  address?: string;
  className?: string;
  showAddress?: boolean;
}) {
  const { data } = useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "nameOf",
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 20000 },
  });

  if (!address) return <span className="mono text-[11px] text-muted">unassigned</span>;

  const name = typeof data === "string" ? data : "";

  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <a
        href={addressUrl(address)}
        target="_blank"
        rel="noreferrer"
        title={`${address} · open on the explorer for the full history`}
        className={`group inline-flex flex-wrap items-baseline gap-1.5 ${className}`}
      >
        {name ? (
          <>
            <span className="mono text-[11px] text-text group-hover:text-accent">@{name}</span>
            {showAddress ? (
              <span className="mono text-[9px] text-muted group-hover:text-accent/70">
                {shortAddress(address)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="mono text-[11px] text-text group-hover:text-accent">{shortAddress(address)}</span>
        )}
        <span className="text-[9px] text-muted opacity-0 transition-opacity group-hover:opacity-100">↗</span>
      </a>
      <Link
        href={`/u/${address}`}
        className="mono text-[9px] text-muted hover:text-accent"
        aria-label={`PACT history for ${name ? `@${name}` : address}`}
      >
        history
      </Link>
    </span>
  );
}
