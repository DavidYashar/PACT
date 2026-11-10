import { cookies } from "next/headers";
import { createPublicClient, http } from "viem";
import { ESCROW_ADDRESS, LOGS_RPC_URL, NAMES_ADDRESS, activeChain } from "./chain";
import { namesAbi, pactAbi } from "./contract";
import { SESSION_COOKIE, readSession } from "./session-server";
import { getJobContent, getProof } from "./content";
import { assertDeployment } from "./env-guard";

/// Every server-side read goes through here first. A deployment with a missing address, no database or
/// a draft session secret answers nothing at all rather than answering from somewhere else.
assertDeployment();

/// Reads the signed-session cookie. Returns null when there is no valid session.
export async function currentSession(): Promise<{ address: string; expires: number } | null> {
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value);
}

export function chainClient() {
  /// Server-side reads may use a keyed endpoint, which is where the rate limit actually bites.
  /// The browser gets the chain's public default; it never sees this URL.
  return createPublicClient({
    chain: activeChain,
    transport: http(process.env.RPC_URL, { fetchOptions: { headers: { "User-Agent": "pact-web" } } }),
  });
}

/// Reads logs. Separate from `chainClient` because the log-serving endpoint is not always the
/// one that serves state; see `LOGS_RPC_URL`.
export function logClient() {
  return createPublicClient({
    chain: activeChain,
    transport: http(LOGS_RPC_URL, { fetchOptions: { headers: { "User-Agent": "pact-web" } } }),
  });
}

export type ChainJob = {
  employer: string;
  worker: string;
  filer: string;
  state: number;
  budget: bigint;
  price: bigint;
  bond: bigint;
  employerEscrow: bigint;
  workerEscrow: bigint;
  /// What the filer committed to when the ticket was raised. Zero when nobody filed.
  reasonHash: string;
  disputedAt: bigint;
  timedOut: boolean;
};

export async function readJob(jobId: number): Promise<ChainJob & { proofHash: string; termsHash: string } | null> {
  try {
    const client = chainClient();
    const job = (await client.readContract({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "getJob",
      args: [BigInt(jobId)],
    })) as unknown as ChainJob & { proofHash: string; termsHash: string };
    return job;
  } catch {
    return null;
  }
}

/// The bids a job actually has on chain. Used to reject stored pitches that belong to a
/// different deployment that happened to reuse the same job id.
export async function readBids(jobId: number): Promise<{ worker: string; price: bigint; accepted: boolean }[]> {
  try {
    const client = chainClient();
    const bids = (await client.readContract({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "getBids",
      args: [BigInt(jobId)],
    })) as unknown as { worker: string; price: bigint; accepted: boolean }[];
    return Array.isArray(bids) ? bids : [];
  } catch {
    return [];
  }
}

export async function readResolver(): Promise<string | null> {  try {
    const client = chainClient();
    const resolver = await client.readContract({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "resolver",
    });
    return typeof resolver === "string" ? resolver : null;
  } catch {
    return null;
  }
}

/// Whether a settled job has been inscribed into the registry. Once true, the text behind its
/// hashes is destroyed and the contract is the only record left.
export async function readRecorded(jobId: number): Promise<boolean> {
  try {
    const client = chainClient();
    const done = await client.readContract({
      address: NAMES_ADDRESS,
      abi: namesAbi,
      functionName: "recorded",
      args: [BigInt(jobId)],
    });
    return done === true;
  } catch {
    return false;
  }
}

const eq = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export function isParty(job: ChainJob, address?: string) {
  return eq(job.employer, address) || eq(job.worker, address);
}

/// Everything one ticket needs, assembled server-side so a caller cannot ask for a
/// job they are not entitled to.
export async function ticketDetail(jobId: number) {
  const [job, content, proof, resolver] = await Promise.all([
    readJob(jobId),
    getJobContent(jobId),
    getProof(jobId),
    readResolver(),
  ]);

  if (!job) return null;

  return { jobId, job, content, proof, resolver };
}
