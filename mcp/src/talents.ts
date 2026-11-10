// Who to work with.
//
// Every number is read from the registry, where it is written once per settled job. Nothing is
// derived by scanning jobs and nothing lives off chain, so a ranking cannot disagree with the
// chain: this file is a multicall over `profileOf` plus a sort.
//
// The boards are counts, not grades. There is no composite trust score, because nobody could
// verify one. What an agent can check is "nine jobs paid, one ticket lost" — and recompute the
// rank from the columns returned beside it.

import { config, type Address } from "./config.js";
import { client, readProfile } from "./chain.js";
import { namesAbi } from "./abi.js";

export type TalentRow = {
  address: Address;
  name: string | null;
  kind: "AI" | "HUMAN";
  jobsDone: number;
  /// Tickets are counted per address, never per side: a profile's `ticketsWon` is "rulings that went
  /// this wallet's way", whichever side it took. Employing on one job and working on another merges
  /// both, so these are reported once and never split by role.
  ticketsWon: number;
  ticketsLost: number;
  abandoned: number;
  received: bigint;
  bonded: bigint;
  netEarned: bigint;
  jobsPosted: number;
  stakedAsEmployer: bigint;
  receivedAsEmployer: bigint;
  feesPaid: bigint;
  netSpent: bigint;
  /// Jobs settled at all, as either side, and the slice of those worked rather than posted. The
  /// registry pushes a settled job into both parties' histories once and `require(worker != employer)`
  /// means the sides never overlap, so `worked = settledJobs − jobsPosted` is exact.
  settledJobs: number;
  worked: number;
  workedAsWorker: boolean;
  postedJob: boolean;
  workerUnits: number | null;
  employerUnits: number | null;
  /// Tickets are one counter per wallet, so a wallet with settled work on both sides that lost a
  /// complaint cannot have that loss attributed to a side. It is charged on both, and flagged here.
  mixedSides: boolean;
};

export const BOARDS = ["workers", "employers", "earners", "payers", "disputes"] as const;
export type Board = (typeof BOARDS)[number];

export const FORMULAS: Record<Board, string> = {
  workers: "jobsDone − ticketsLost − abandoned. A worker who wins one and loses one ranks below one who wins one.",
  employers: "jobsPosted − ticketsLost. An employer who loses a complaint stops climbing.",
  earners: "WIF credited as a worker minus the bond staked. A returned bond is not income.",
  payers: "price staked minus refunds received, as an employer. Filing fees are shown beside it — real spend, but not payment for work.",
  disputes: "tickets won, then tickets lost.",
};

const REGISTRY_DEPLOY_BLOCK = BigInt(process.env.PACT_NAMES_DEPLOY_BLOCK ?? "150504098");
const ROW_TTL_MS = 15_000;

type Cache = {
  registrants: Set<Address>;
  lastBlock: bigint;
  rows: TalentRow[];
  builtAt: number;
};

let cache: Cache | null = null;

/// The registry keeps a mapping, so it cannot be asked "who exists". Its own `UsernameRegistered`
/// events can, which makes this one filtered log query remembered in memory and extended by block
/// range — not an indexer, and nothing that can fall out of sync with the chain.
async function registrants() {
  const head = await client.getBlockNumber();
  const known = cache?.registrants ?? new Set<Address>();
  const from = cache ? cache.lastBlock + 1n : REGISTRY_DEPLOY_BLOCK;

  if (from <= head) {
    const logs = await client.getContractEvents({
      address: config.names,
      abi: namesAbi,
      eventName: "UsernameRegistered",
      fromBlock: from,
      toBlock: head,
    });
    for (const log of logs) {
      const owner = (log.args as { owner?: Address }).owner;
      if (owner) known.add(owner);
    }
    cache = { registrants: known, lastBlock: head, rows: cache?.rows ?? [], builtAt: cache?.builtAt ?? 0 };
  }

  return { addresses: [...known], lastBlock: head };
}

async function rows(): Promise<{ rows: TalentRow[]; lastBlock: bigint }> {
  const { addresses, lastBlock } = await registrants();

  if (cache && Date.now() - cache.builtAt < ROW_TTL_MS && cache.rows.length > 0) {
    return { rows: cache.rows, lastBlock };
  }

  /// One multicall for every profile, which is only possible because the aggregates are counters on
  /// chain. Falls back to individual reads if the deployment has no Multicall3.
  const settled = await settledJobs(addresses);
  let built: TalentRow[] = [];
  try {
    const results = await client.multicall({
      multicallAddress: MULTICALL3,
      contracts: addresses.map((address) => ({
        address: config.names,
        abi: namesAbi,
        functionName: "profileOf" as const,
        args: [address] as const,
      })),
      allowFailure: true,
    });
    built = results
      .map((result, index) => {
        if (result.status !== "success" || !result.result) return null;
        return toRow(addresses[index], result.result as never, settled[index]);
      })
      .filter((row): row is TalentRow => row !== null);
  } catch {
    built = await Promise.all(
      addresses.map(async (address, index) => {
        const profile = await readProfile(address);
        return profile ? toRow(address, profile as never, settled[index]) : null;
      }),
    ).then((list) => list.filter((row): row is TalentRow => row !== null));
  }

  cache = {
    registrants: cache?.registrants ?? new Set(addresses),
    lastBlock: cache?.lastBlock ?? lastBlock,
    rows: built,
    builtAt: Date.now(),
  };

  return { rows: built, lastBlock };
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/// How many jobs each wallet has settled, as either side. One extra multicall, and it is what makes
/// `worked` exact rather than a guess from counters that merge the two roles.
async function settledJobs(addresses: Address[]): Promise<(number | null)[]> {
  try {
    const results = await client.multicall({
      multicallAddress: MULTICALL3,
      contracts: addresses.map((address) => ({
        address: config.names,
        abi: namesAbi,
        functionName: "historyLength" as const,
        args: [address] as const,
      })),
      allowFailure: true,
    });
    return results.map((result) => (result.status === "success" ? Number(result.result as bigint) : null));
  } catch {
    return addresses.map(() => null);
  }
}

function toRow(address: Address, profile: {
  name: string;
  kind: number;
  registeredAt: bigint;
  jobsPosted: number;
  jobsDone: number;
  ticketsWon: number;
  ticketsLost: number;
  abandoned: number;
  receivedAsWorker: bigint;
  bondedAsWorker: bigint;
  stakedAsEmployer: bigint;
  receivedAsEmployer: bigint;
  feesPaid: bigint;
}, settledJobs: number | null): TalentRow {
  /// `bondedAsWorker` and `jobsPosted` only move inside `record()`, so each is exactly "has this
  /// wallet ever settled a job on that side". A wallet with no history on a side gets `null`, not a
  /// number: a pure employer who loses a complaint must not show a negative *worker* score.
  const workedAsWorker = profile.bondedAsWorker > 0n;
  const postedJob = profile.jobsPosted > 0;
  const workerUnits = workedAsWorker ? profile.jobsDone - profile.ticketsLost - profile.abandoned : null;
  const employerUnits = postedJob ? profile.jobsPosted - profile.ticketsLost : null;
  return {
    address,
    name: profile.name && profile.name.length > 0 ? profile.name : null,
    kind: profile.kind === 1 ? "AI" : "HUMAN",
    jobsDone: profile.jobsDone,
    ticketsWon: profile.ticketsWon,
    ticketsLost: profile.ticketsLost,
    abandoned: profile.abandoned,
    received: profile.receivedAsWorker,
    bonded: profile.bondedAsWorker,
    netEarned: profile.receivedAsWorker - profile.bondedAsWorker,
    jobsPosted: profile.jobsPosted,
    stakedAsEmployer: profile.stakedAsEmployer,
    receivedAsEmployer: profile.receivedAsEmployer,
    feesPaid: profile.feesPaid,
    netSpent: profile.stakedAsEmployer - profile.receivedAsEmployer,
    settledJobs: settledJobs ?? profile.jobsPosted + profile.jobsDone,
    worked: Math.max(0, (settledJobs ?? profile.jobsPosted + profile.jobsDone) - profile.jobsPosted),
    workedAsWorker,
    postedJob,
    workerUnits,
    employerUnits,
    mixedSides: workedAsWorker && postedJob && profile.ticketsLost > 0,
  };
}

/// Whether a wallet has anything to rank on for this board. A wallet with no settled job is still
/// findable — a new agent has to be discoverable or it can never be hired — but it comes back last
/// and unflagged rather than pretending to a rank, or a score, it has not earned.
export function isRanked(row: TalentRow, board: Board): boolean {
  switch (board) {
    case "workers":
      return row.workerUnits !== null;
    case "employers":
      return row.employerUnits !== null;
    case "earners":
      return row.jobsDone > 0 || row.abandoned > 0;
    case "payers":
      return row.jobsPosted > 0;
    case "disputes":
      return row.ticketsWon + row.ticketsLost > 0;
  }
}

function cmpBig(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

function compare(board: Board): (a: TalentRow, b: TalentRow) => number {
  const byAddress = (a: TalentRow, b: TalentRow) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1);
  const workers = (a: TalentRow, b: TalentRow) => (b.workerUnits ?? 0) - (a.workerUnits ?? 0);
  const employers = (a: TalentRow, b: TalentRow) => (b.employerUnits ?? 0) - (a.employerUnits ?? 0);
  switch (board) {
    case "workers":
      return (a, b) => workers(a, b) || b.jobsDone - a.jobsDone || cmpBig(b.netEarned, a.netEarned) || byAddress(a, b);
    case "employers":
      return (a, b) => employers(a, b) || b.jobsPosted - a.jobsPosted || cmpBig(b.netSpent, a.netSpent) || byAddress(a, b);
    case "earners":
      return (a, b) => cmpBig(b.netEarned, a.netEarned) || b.jobsDone - a.jobsDone || byAddress(a, b);
    case "payers":
      return (a, b) => cmpBig(b.netSpent, a.netSpent) || b.jobsPosted - a.jobsPosted || byAddress(a, b);
    case "disputes":
      return (a, b) =>
        b.ticketsWon - a.ticketsWon ||
        a.ticketsLost - b.ticketsLost ||
        b.jobsDone - a.jobsDone ||
        byAddress(a, b);
  }
}

export async function findTalent(params: {
  board?: Board;
  query?: string;
  kind?: "AI" | "HUMAN";
  rankedOnly?: boolean;
  limit?: number;
}) {
  const board: Board = params.board ?? "workers";
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const needle = (params.query ?? "").trim().toLowerCase();

  let loaded: Awaited<ReturnType<typeof rows>>;
  try {
    loaded = await rows();
  } catch (error) {
    return {
      ok: false as const,
      reason: `could not read the registry: ${String(error).slice(0, 160)}`,
      fix: "the node may be rate limiting; retry, or read one address with pact_get_profile",
    };
  }

  const matching = loaded.rows.filter((row) => {
    if (params.kind && row.kind !== params.kind) return false;
    if (!needle) return true;
    if (row.name && row.name.toLowerCase().includes(needle)) return true;
    return row.address.toLowerCase().includes(needle) && needle.length >= 4;
  });

  const ranked = matching.filter((row) => isRanked(row, board)).sort(compare(board));
  const unranked = matching
    .filter((row) => !isRanked(row, board))
    .sort((a, b) => ((a.name ?? a.address) < (b.name ?? b.address) ? -1 : 1));
  const ordered = params.rankedOnly ? ranked : [...ranked, ...unranked];

  return {
    ok: true as const,
    board,
    formula: FORMULAS[board],
    asOfBlock: Number(loaded.lastBlock),
    /// Where these came from, so a caller can check rather than trust: the registry counters, not a
    /// database. Every row carries its own inputs.
    source: `PactNames.profileOf at ${config.names}`,
    matched: matching.length,
    returned: Math.min(ordered.length, limit),
    rows: ordered.slice(0, limit).map((row) => ({
      rank: isRanked(row, board) ? ranked.indexOf(row) + 1 : null,
      address: row.address,
      username: row.name,
      kind: row.kind,
      jobsDone: row.jobsDone,
      jobsPosted: row.jobsPosted,
      settledJobs: row.settledJobs,
      worked: row.worked,
      ticketsWon: row.ticketsWon,
      ticketsLost: row.ticketsLost,
      abandoned: row.abandoned,
      receivedAsWorker: row.received.toString(),
      bondedAsWorker: row.bonded.toString(),
      netEarned: row.netEarned.toString(),
      stakedAsEmployer: row.stakedAsEmployer.toString(),
      receivedAsEmployer: row.receivedAsEmployer.toString(),
      feesPaid: row.feesPaid.toString(),
      netSpent: row.netSpent.toString(),
      workerUnits: row.workerUnits,
      employerUnits: row.employerUnits,
      /// False when this wallet has no settled work on the side this board ranks, so its units are
      /// `null`. Unranked wallets come back last, because a new agent has to be findable to be hired.
      hasHistory: isRanked(row, board),
      /// Set when a lost ticket could not be attributed to one side, so it was charged on both.
      mixedSides: row.mixedSides,
    })),
    note:
      matching.length === 0
        ? needle
          ? `nothing on this registry matches "${params.query}". Drop the query to list every registered wallet, or read one address with pact_get_profile.`
          : `no registered wallet matches that filter. Drop kind to include everyone.`
        : ranked.length === 0
          ? "no wallet in this result has settled work yet, so this is an unranked directory"
          : undefined,
  };
}
