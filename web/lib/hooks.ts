"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { parseAbiItem } from "viem";
import { erc20Abi, ESCROW_ADDRESS, pactAbi, WIF_ADDRESS, type Job } from "./contract";

export function useJobCount() {
  return useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "jobCount",
    query: { refetchInterval: 4000 },
  });
}

/// Reads every job in one multicall. Fine up to a few hundred jobs; past that, move to an indexer.
export function useAllJobs() {
  const { data: count, isLoading } = useJobCount();
  const total = Number(count ?? 0);

  const results = useReadContracts({
    contracts: Array.from({ length: total }, (_, i) => ({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "getJob",
      args: [BigInt(i + 1)],
    })),
    query: { enabled: total > 0, refetchInterval: 4000 },
  });

  const jobs: { id: number; job: Job }[] = [];
  results.data?.forEach((entry, i) => {
    if (entry.status === "success" && entry.result) {
      jobs.push({ id: i + 1, job: entry.result as unknown as Job });
    }
  });

  return { jobs, total, isLoading: isLoading || results.isLoading, refetch: results.refetch };
}

export function useJob(id: number) {
  return useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "getJob",
    args: id > 0 ? [BigInt(id)] : undefined,
    query: { enabled: id > 0, refetchInterval: 4000 },
  });
}

export function useBids(id: number) {
  return useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "getBids",
    args: id > 0 ? [BigInt(id)] : undefined,
    query: { enabled: id > 0, refetchInterval: 4000 },
  });
}

export function useClaimable(account?: `0x${string}`) {
  return useReadContract({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    functionName: "claimable",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 4000 },
  });
}

export function useWifBalance(account?: `0x${string}`) {
  return useReadContract({
    address: WIF_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 6000 },
  });
}

export function useWifAllowance(account?: `0x${string}`) {
  return useReadContract({
    address: WIF_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: account ? [account, ESCROW_ADDRESS] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 6000 },
  });
}

export const TERMS_EVENT = parseAbiItem(
  "event JobPosted(uint256 indexed jobId, address indexed employer, uint256 budget, bytes32 termsHash)",
);

export const ALL_EVENTS = [
  "event JobPosted(uint256 indexed jobId, address indexed employer, uint256 budget, bytes32 termsHash)",
  "event JobCancelled(uint256 indexed jobId)",
  "event BidPlaced(uint256 indexed jobId, address indexed worker, uint256 price)",
  "event BidAccepted(uint256 indexed jobId, address indexed worker, uint256 price, uint256 bond)",
  "event Delivered(uint256 indexed jobId, bytes32 proofHash, uint64 autoReleaseAt)",
  "event DeliveryApproved(uint256 indexed jobId, uint256 toWorker, uint256 toTreasury)",
  "event JobAbandoned(uint256 indexed jobId, uint256 toEmployer, uint256 toTreasury)",
  "event DisputeRaised(uint256 indexed jobId, address indexed filer, uint256 filingFee, bytes32 reasonHash)",
  "event DisputeResolved(uint256 indexed jobId, uint8 ruling, uint256 toEmployer, uint256 toWorker, uint256 toTreasury, uint256 fine)",
  "event Claimed(address indexed account, uint256 amount)",
] as const;
