import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { config, type Address } from "./config.js";
import { escrowAbi, namesAbi, wifAbi } from "./abi.js";

/// Reads only. Nothing in this server signs or sends.
export const client: PublicClient = createPublicClient({
  transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }),
});

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export type Job = {
  employer: Address;
  worker: Address;
  filer: Address;
  state: number;
  budget: bigint;
  price: bigint;
  bond: bigint;
  employerEscrow: bigint;
  workerEscrow: bigint;
  bidDeadline: bigint;
  deliveryDeadline: bigint;
  autoReleaseAt: bigint;
  /// The silence window this job chose at posting time, in seconds.
  autoReleaseDelay: bigint;
  /// When the open ticket was filed, so the timeout can be checked against it.
  disputedAt: bigint;
  /// What the filer committed to. Any surface showing a complaint must re-hash the text to this.
  reasonHash: `0x${string}`;
  termsHash: `0x${string}`;
  proofHash: `0x${string}`;
  workerWon: boolean;
  /// A ticket that timed out with nothing delivered: settled, but nobody was marked.
  timedOut: boolean;
  settledAt: bigint;
  toEmployerPaid: bigint;
  toWorkerPaid: bigint;
};

export async function readJob(jobId: bigint): Promise<Job | null> {
  try {
    const job = (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "getJob",
      args: [jobId],
    })) as unknown as Job;
    if (job.employer === "0x0000000000000000000000000000000000000000") return null;
    return job;
  } catch {
    return null;
  }
}

export async function readJobCount(): Promise<bigint> {
  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "jobCount",
    })) as bigint;
  } catch {
    return 0n;
  }
}

export type Bid = { worker: Address; price: bigint; accepted: boolean; withdrawn: boolean };

export async function readBids(jobId: bigint): Promise<Bid[]> {
  try {
    const bids = (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "getBids",
      args: [jobId],
    })) as unknown as Bid[];
    return Array.isArray(bids) ? bids : [];
  } catch {
    return [];
  }
}

export async function readClaimable(address: Address): Promise<bigint> {
  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "claimable",
      args: [address],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/// Whether this settled job has already been inscribed. The registry is namespaced by escrow, so
/// a record from an earlier deployment cannot be mistaken for this one.
export async function readRecordedFor(jobId: bigint): Promise<boolean> {
  return (await client.readContract({
    address: config.names,
    abi: namesAbi,
    functionName: "recordedFor",
    args: [config.escrow, jobId],
  })) as boolean;
}

export async function readUnrecorded(address: Address): Promise<bigint> {
  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "unrecorded",
      args: [address],
    })) as bigint;
  } catch {
    return 0n;
  }
}

export async function readResolver(): Promise<Address | null> {
  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "resolver",
    })) as Address;
  } catch {
    return null;
  }
}

/// The auto-release window is a constructor argument, not a constant: a deployment may run minutes so the
/// path can be exercised, mainnet runs days. Anything that states the window must read it from the
/// deployment rather than assume the mainnet figure.
export async function readAutoReleaseDelay(): Promise<number | null> {
  try {
    const seconds = (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "defaultAutoReleaseDelay",
    })) as bigint;
    return Number(seconds);
  } catch {
    return null;
  }
}

/// The smallest settled price the registry will count towards a profile. A deployment constant, so
/// read once rather than restated in the client: a copy in a message would drift from the chain the
/// first time it is tuned.
let minCountedPriceCache: bigint | undefined;

export async function readMinCountedPrice(): Promise<bigint | undefined> {
  if (minCountedPriceCache !== undefined) return minCountedPriceCache;
  try {
    const price = (await client.readContract({
      address: config.names,
      abi: namesAbi,
      functionName: "MIN_COUNTED_PRICE",
    })) as bigint;
    minCountedPriceCache = price;
    return price;
  } catch {
    return undefined;
  }
}

/// The fine and the treasury cut are not in the job struct: they exist only in DisputeResolved,
/// while the filing fee moved earlier, in DisputeRaised. All three are read back, and reported
/// separately — collapsing them into one "fees" number is how a party ends up unable to reconcile
/// what it lost. Job id is indexed, so each is one filtered query from the deploy block.
export async function readDisputeResolution(jobId: bigint): Promise<{
  ruling: "worker" | "employer";
  toEmployer: bigint;
  toWorker: bigint;
  cut: bigint;
  fine: bigint;
  filingFee: bigint;
  filedBy: Address | null;
  blockNumber: bigint;
} | null> {
  try {
    const [resolved, raised] = await Promise.all([
      client.getContractEvents({
        address: config.escrow,
        abi: escrowAbi,
        eventName: "DisputeResolved",
        args: { jobId },
        fromBlock: config.escrowDeployBlock,
        toBlock: "latest",
      }),
      client.getContractEvents({
        address: config.escrow,
        abi: escrowAbi,
        eventName: "DisputeRaised",
        args: { jobId },
        fromBlock: config.escrowDeployBlock,
        toBlock: "latest",
      }),
    ]);
    const last = resolved[resolved.length - 1];
    if (!last) return null;
    const args = last.args as {
      ruling: number;
      toEmployer: bigint;
      toWorker: bigint;
      toTreasury: bigint;
      fine: bigint;
    };
    const filing = raised[raised.length - 1]?.args as { filer?: Address; filingFee?: bigint } | undefined;
    return {
      ruling: Number(args.ruling) === 0 ? "worker" : "employer",
      toEmployer: args.toEmployer,
      toWorker: args.toWorker,
      cut: args.toTreasury,
      fine: args.fine,
      filingFee: filing?.filingFee ?? 0n,
      filedBy: filing?.filer ?? null,
      blockNumber: last.blockNumber ?? 0n,
    };
  } catch {
    return null;
  }
}

/// Money reads back a precondition, so a failure must not be reported as a zero balance:
/// "you hold nothing" and "the node did not answer" lead to different decisions.
export async function readWifBalance(address: Address): Promise<bigint> {
  return (await client.readContract({
    address: config.wif,
    abi: wifAbi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

export async function readAllowance(owner: Address, spender: Address): Promise<bigint> {
  return (await client.readContract({
    address: config.wif,
    abi: wifAbi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}

/// For display only: a failed read shows as "unavailable" rather than as zero.
export async function tryRead(fn: () => Promise<bigint>): Promise<bigint | null> {
  try {
    return await fn();
  } catch (error) {
    console.warn("read failed", (error as Error).message);
    return null;
  }
}

export type Profile = {
  name: string;
  kind: number;
  registeredAt: bigint;
  jobsPosted: number;
  jobsDone: number;
  tickets: number;
  spentAsEmployer: bigint;
  earnedAsWorker: bigint;
  /// Scoreboard counters, written once per settled job. They are counts of finished things, never
  /// judgments: the escrow decides who won, the registry only tallies it.
  ticketsWon: number;
  ticketsLost: number;
  abandoned: number;
  receivedAsWorker: bigint;
  bondedAsWorker: bigint;
  stakedAsEmployer: bigint;
  receivedAsEmployer: bigint;
  feesPaid: bigint;
};

export async function readProfile(address: Address): Promise<Profile | null> {
  try {
    return (await client.readContract({
      address: config.names,
      abi: namesAbi,
      functionName: "profileOf",
      args: [address],
    })) as unknown as Profile;
  } catch {
    return null;
  }
}

export async function isRegistered(address: Address): Promise<boolean> {
  try {
    return (await client.readContract({
      address: config.names,
      abi: namesAbi,
      functionName: "isRegistered",
      args: [address],
    })) as boolean;
  } catch {
    return false;
  }
}

export async function ownerOfName(name: string): Promise<Address | null> {
  try {
    const owner = (await client.readContract({
      address: config.names,
      abi: namesAbi,
      functionName: "ownerOfName",
      args: [name],
    })) as Address;
    return owner === "0x0000000000000000000000000000000000000000" ? null : owner;
  } catch {
    return null;
  }
}

export type Record_ = {
  jobId: bigint;
  employer: Address;
  worker: Address;
  termsHash: `0x${string}`;
  proofHash: `0x${string}`;
  hadTicket: boolean;
  workerWon: boolean;
  paidToWorker: bigint;
  spentByEmployer: bigint;
  settledAt: bigint;
  recordedBy: Address;
};

export async function readRecord(jobId: bigint): Promise<Record_ | null> {
  try {
    return (await client.readContract({
      address: config.names,
      abi: namesAbi,
      functionName: "recordOf",
      args: [jobId],
    })) as unknown as Record_;
  } catch {
    return null;
  }
}

export async function readHistory(address: Address): Promise<bigint[]> {
  try {
    return (await client.readContract({
      address: config.names,
      abi: namesAbi,
      functionName: "historyOf",
      args: [address],
    })) as bigint[];
  } catch {
    return [];
  }
}

/// The next nonce the chain has not seen yet. "pending" matters: a transaction still in the
/// mempool still owns its nonce.
export async function pendingNonce(address: Address): Promise<bigint> {
  return BigInt(await client.getTransactionCount({ address, blockTag: "pending" }));
}

export async function estimateGas(tx: {
  account: Address;
  to: Address;
  data: `0x${string}`;
  value?: bigint;
}): Promise<bigint> {
  const est = await client.estimateGas({
    account: tx.account,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  // A little headroom: a state read can land between estimate and execution.
  return (est * 12n) / 10n;
}
