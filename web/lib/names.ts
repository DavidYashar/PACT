"use client";

import { useReadContract } from "wagmi";
import { ESCROW_ADDRESS, NAMES_ADDRESS, namesAbi, pactAbi, type JobRecord, type Profile } from "./contract";

/// The name registry holds identity and points, so it outlives any escrow upgrade.
export function useProfile(account?: `0x${string}`) {
  return useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "profileOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 6000 },
  }) as { data?: Profile; refetch: () => void };
}

/// Nothing that produces a record may happen before a wallet owns a name. `ready` is separate
/// from `registered` so a registered wallet never flashes the gate while the first read lands.
export function useIsRegistered(account?: `0x${string}`) {
  const { data: profile } = useProfile(account);
  return {
    profile,
    ready: profile !== undefined,
    registered: Boolean(profile && profile.registeredAt > 0n),
  };
}

/// The smallest settled price the registry will count towards a profile. A deployment constant, so
/// the page reads it rather than restating it: a sentence carrying its own copy of the number would
/// go stale the first time it is tuned. If the read fails the note is simply not shown, which beats
/// showing a number nobody verified.
export function useMinCountedPrice(): bigint | undefined {
  const { data } = useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "MIN_COUNTED_PRICE",
    query: { staleTime: Infinity, gcTime: Infinity },
  });
  return data as bigint | undefined;
}

export function useNameOf(account?: `0x${string}`) {
  return useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "nameOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 15000 },
  }) as { data?: string; refetch: () => void };
}

export function useOwnerOfName(name?: string) {
  const normalized = (name ?? "").trim().toLowerCase();
  return useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "ownerOfName",
    args: normalized ? [normalized] : undefined,
    query: { enabled: normalized.length >= 3, refetchInterval: 8000 },
  }) as { data?: `0x${string}`; refetch: () => void };
}

/// One settled job, frozen forever. Hashes only.
export function useRecord(jobId?: number) {
  return useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "recordOf",
    args: jobId && jobId > 0 ? [BigInt(jobId)] : undefined,
    query: { enabled: Boolean(jobId && jobId > 0), refetchInterval: 6000 },
  }) as { data?: JobRecord; refetch: () => void };
}

export function useIsRecorded(jobId?: number) {
  return useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "recorded",
    args: jobId && jobId > 0 ? [BigInt(jobId)] : undefined,
    query: { enabled: Boolean(jobId && jobId > 0), refetchInterval: 4000 },
  }) as { data?: boolean; refetch: () => void };
}

export function useHistory(account?: `0x${string}`) {
  return useReadContract({
    address: NAMES_ADDRESS,
    abi: namesAbi,
    functionName: "historyOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 8000 },
  }) as { data?: bigint[]; refetch: () => void };
}

/// How many settled jobs this account still owes a record for. Non-zero blocks every claim,
/// because claim() pays all of a wallet's balance in one transfer.
export function useUnrecorded(account?: `0x${string}`) {
  return useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "unrecorded",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 4000 },
  }) as { data?: bigint; refetch: () => void };
}

/// Normalise exactly the way the contract does, so the form can check availability client-side.
export function normalizeName(raw: string) {
  return raw.trim().toLowerCase();
}

export function nameProblem(raw: string): string | null {
  const n = normalizeName(raw);
  if (n.length === 0) return null;
  if (n.length < 3) return "at least 3 characters";
  if (n.length > 20) return "at most 20 characters";
  if (!/^[a-z0-9_]+$/.test(n)) return "letters, numbers and underscore only";
  return null;
}
