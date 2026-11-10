import { namesAbi, pactAbi } from "./abi";
import { ESCROW_ADDRESS, NAMES_ADDRESS, WIF_ADDRESS } from "./chain";

export { namesAbi, pactAbi, ESCROW_ADDRESS, NAMES_ADDRESS, WIF_ADDRESS };

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const State = {
  NONE: 0,
  OPEN: 1,
  ASSIGNED: 2,
  DELIVERED: 3,
  DISPUTED: 4,
  SETTLED: 5,
  CANCELLED: 6,
} as const;

export const STATE_LABEL: Record<number, string> = {
  0: "none",
  1: "open",
  2: "assigned",
  3: "delivered",
  4: "disputed",
  5: "settled",
  6: "cancelled",
};

export type Job = {
  employer: `0x${string}`;
  worker: `0x${string}`;
  filer: `0x${string}`;
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
  termsHash: `0x${string}`;
  proofHash: `0x${string}`;
  workerWon: boolean;
  settledAt: bigint;
  toEmployerPaid: bigint;
  toWorkerPaid: bigint;
};

/// A settled job, frozen. Hashes only — the text behind them is destroyed once this exists.
export type JobRecord = {
  jobId: bigint;
  employer: `0x${string}`;
  worker: `0x${string}`;
  termsHash: `0x${string}`;
  proofHash: `0x${string}`;
  hadTicket: boolean;
  workerWon: boolean;
  paidToWorker: bigint;
  spentByEmployer: bigint;
  settledAt: bigint;
  recordedBy: `0x${string}`;
};

export type Profile = {
  name: string;
  kind: number;
  registeredAt: bigint;
  jobsPosted: number;
  jobsDone: number;
  tickets: number;
  spentAsEmployer: bigint;
  earnedAsWorker: bigint;
  /// Scoreboard counters, written once per settled job. Counts of finished things, never judgments:
  /// the escrow decides who won, the registry only tallies it.
  ticketsWon: number;
  ticketsLost: number;
  abandoned: number;
  receivedAsWorker: bigint;
  bondedAsWorker: bigint;
  stakedAsEmployer: bigint;
  receivedAsEmployer: bigint;
  feesPaid: bigint;
};

export const Kind = { HUMAN: 0, AI: 1 } as const;

export type Bid = {
  worker: `0x${string}`;
  price: bigint;
  accepted: boolean;
  /// A withdrawn bid stays on the book so an employer can see why it cannot be accepted.
  withdrawn: boolean;
};
