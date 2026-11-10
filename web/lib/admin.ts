"use client";

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { ESCROW_ADDRESS, pactAbi } from "./contract";

const ZERO = "0x0000000000000000000000000000000000000000";

function extraAdmins(): string[] {
  return (process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value));
}

/// Treasury-only. Deliberately narrower than `useIsAdmin`: the resolver is an operator
/// but is not the fee recipient, and must not read the fee books.
export function useIsTreasury(address?: `0x${string}`) {
  const { data: treasury } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "treasury",
  });

  const isTreasury = Boolean(
    address && typeof treasury === "string" && treasury.toLowerCase() === address.toLowerCase(),
  );

  return { isTreasury, treasury: treasury as string | undefined };
}

/// Operators are the treasury and the resolver — both read from the contract, so they
/// stay correct if either role is repointed — plus any address listed in
/// NEXT_PUBLIC_ADMIN_ADDRESSES (the deployer, typically).
export function useIsAdmin(address?: `0x${string}`) {  const { data: treasury } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "treasury",
  });

  const { data: resolver } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "resolver",
  });

  const admins = useMemo(() => {
    const set = new Set<string>(extraAdmins());
    for (const value of [treasury, resolver]) {
      if (typeof value === "string" && value.toLowerCase() !== ZERO) set.add(value.toLowerCase());
    }
    return set;
  }, [treasury, resolver]);

  const isAdmin = Boolean(address && admins.has(address.toLowerCase()));

  return { isAdmin, admins: Array.from(admins), treasury: treasury as string | undefined, resolver: resolver as string | undefined };
}
