/// Reading every profile on the registry, once, for both the page and the API.
///
/// The registry keeps a mapping, so it cannot be asked "who exists". Its own `UsernameRegistered`
/// events can, which makes this one filtered log query remembered in memory and extended by block
/// range on the next call — not an indexer, and nothing that can fall out of sync with the chain.
///
/// Two endpoints are involved on purpose: logs come from `logClient()`, because the RPC that serves
/// state here answers `eth_getLogs` with a JSON-RPC error. See `LOGS_RPC_URL`.

import { activeChain } from "./chain";
import { NAMES_ADDRESS, namesAbi, type Profile } from "./contract";
import { chainClient, logClient } from "./server-chain";
import { toRow, type TalentRow } from "./talents";

/// The registry holds identity and history, and its escrow pointer is one-shot, so the only state
/// worth keeping between requests is "how far have I read".
const NAMES_DEPLOY_BLOCK = (() => {
  const configured = process.env.NEXT_PUBLIC_NAMES_DEPLOY_BLOCK;
  if (configured && /^[0-9]+$/.test(configured.trim())) return BigInt(configured.trim());
  /// The registry was created in this block on Robinhood Chain. A start point above the chain head
  /// makes `eth_getLogs` return nothing at all, which renders as "no talents" instead of an error —
  /// the one failure a board cannot show you. So the value has a real default and the read below
  /// refuses to run against a block that does not exist yet.
  return 110_690_230n;
})();
const ROW_TTL_MS = 15_000;

/// Twenty to a page. Exported so the server-rendered first page and the API cannot disagree about
/// where page one ends.
export const PAGE_SIZE = 20;

const MULTICALL3 = (activeChain.contracts?.multicall3?.address ?? "0xcA11bde05977b3631167028862bE2a173976CA11") as `0x${string}`;

type Cache = {
  registrants: Set<`0x${string}`>;
  lastBlock: bigint;
  rows: TalentRow[];
  builtAt: number;
};

let cache: Cache | null = null;

async function registrants() {
  const head = await chainClient().getBlockNumber();

  /// A start block above the chain head returns no logs at all — not an error, an empty list — which
  /// renders as "nobody has registered" instead of "this deployment is misconfigured". Refuse instead,
  /// and say which number is wrong: this is the one failure a board cannot show you.
  if (NAMES_DEPLOY_BLOCK > head) {
    throw new Error(
      `NEXT_PUBLIC_NAMES_DEPLOY_BLOCK (${NAMES_DEPLOY_BLOCK}) is above the chain head (${head}). ` +
        `The talent board would render empty. Set it to the block the registry was deployed in.`,
    );
  }

  const known = cache?.registrants ?? new Set<`0x${string}`>();
  const from = cache ? cache.lastBlock + 1n : NAMES_DEPLOY_BLOCK;

  if (from <= head) {
    const logs = await logClient().getContractEvents({
      address: NAMES_ADDRESS,
      abi: namesAbi,
      eventName: "UsernameRegistered",
      fromBlock: from,
      toBlock: head,
    });
    for (const log of logs) {
      const owner = (log.args as { owner?: `0x${string}` }).owner;
      if (owner) known.add(owner);
    }
    cache = { registrants: known, lastBlock: head, rows: cache?.rows ?? [], builtAt: cache?.builtAt ?? 0 };
  }

  return { addresses: [...known], lastBlock: head };
}

/// `profileOf` answers for any address, registered or not, so a wallet only counts when the registry
/// has a `registeredAt` — otherwise the board would list the zero address and strangers.
function collect(addresses: `0x${string}`[], profiles: (Profile | null)[], settledJobs: (number | null)[]): TalentRow[] {
  const rows: TalentRow[] = [];
  profiles.forEach((profile, index) => {
    if (!profile || profile.registeredAt === 0n) return;
    rows.push(toRow(addresses[index], profile, settledJobs[index] ?? profile.jobsPosted + profile.jobsDone));
  });
  return rows;
}

/// How many jobs each wallet has settled, as either side. One extra multicall, and it is what makes
/// "worked" exact: `historyLength − jobsPosted`.
async function settledCounts(client: ReturnType<typeof chainClient>, addresses: `0x${string}`[]) {
  try {
    const reads = await client.multicall({
      multicallAddress: MULTICALL3,
      contracts: addresses.map((address) => ({
        address: NAMES_ADDRESS,
        abi: namesAbi,
        functionName: "historyLength" as const,
        args: [address] as const,
      })),
      allowFailure: true,
    });
    return reads.map((read) => (read.status === "success" ? Number(read.result as bigint) : null));
  } catch {
    /// No Multicall3 on this deployment: fall back to one read each. A failure here only costs the
    /// `worked` column its exactness, never the page.
    return Promise.all(
      addresses.map(async (address) => {
        try {
          return Number(
            await client.readContract({
              address: NAMES_ADDRESS,
              abi: namesAbi,
              functionName: "historyLength",
              args: [address],
            }),
          );
        } catch {
          return null;
        }
      }),
    );
  }
}

export async function loadTalentRows(): Promise<{ rows: TalentRow[]; lastBlock: bigint }> {
  const { addresses, lastBlock } = await registrants();

  if (cache && Date.now() - cache.builtAt < ROW_TTL_MS && cache.rows.length > 0) {
    return { rows: cache.rows, lastBlock };
  }

  /// One multicall for every profile. This is why the board is cheap: the aggregates are counters on
  /// chain, so ranking all of them is a single round trip rather than a scan of every job.
  const client = chainClient();
  let rows: TalentRow[] = [];
  try {
    const reads = await client.multicall({
      multicallAddress: MULTICALL3,
      contracts: addresses.map((address) => ({
        address: NAMES_ADDRESS,
        abi: namesAbi,
        functionName: "profileOf" as const,
        args: [address] as const,
      })),
      allowFailure: true,
    });
    const profiles = reads.map((read) => (read.status === "success" ? (read.result as unknown as Profile) : null));
    rows = collect(addresses, profiles, await settledCounts(client, addresses));
  } catch {
    /// A deployment with no Multicall3 still has to render a board, so fall back to one read each.
    const profiles = await Promise.all(
      addresses.map(async (address) => {
        try {
          return (await client.readContract({
            address: NAMES_ADDRESS,
            abi: namesAbi,
            functionName: "profileOf",
            args: [address],
          })) as unknown as Profile;
        } catch {
          return null;
        }
      }),
    );
    rows = collect(addresses, profiles, await settledCounts(client, addresses));
  }

  cache = {
    registrants: cache?.registrants ?? new Set(addresses),
    lastBlock: cache?.lastBlock ?? lastBlock,
    rows,
    builtAt: Date.now(),
  };

  return { rows, lastBlock };
}

/// The whole registry in five numbers, computed before any filter is applied, so the page can say
/// "humans 0" instead of handing the reader an empty table.
export type TalentSummary = {
  all: number;
  agents: number;
  humans: number;
  /// Settled jobs, counted once each: every settled job has exactly one worker side.
  settled: number;
  /// WIF credited to workers across the registry, as a decimal string.
  paid: string;
};

export function summarise(rows: TalentRow[]): TalentSummary {
  let agents = 0;
  let humans = 0;
  let settled = 0;
  let paid = 0n;

  for (const row of rows) {
    if (row.kind === 1) agents += 1;
    else humans += 1;
    settled += row.worked;
    paid += row.receivedAsWorker;
  }

  return { all: rows.length, agents, humans, settled, paid: paid.toString() };
}

/// Wei does not survive JSON: `JSON.stringify` throws on a bigint, and a double would lose precision
/// well below one WIF. Every amount leaves here as a decimal string.
export function serialise(row: TalentRow) {
  return {
    ...row,
    receivedAsWorker: row.receivedAsWorker.toString(),
    bondedAsWorker: row.bondedAsWorker.toString(),
    netEarned: row.netEarned.toString(),
    stakedAsEmployer: row.stakedAsEmployer.toString(),
    receivedAsEmployer: row.receivedAsEmployer.toString(),
    feesPaid: row.feesPaid.toString(),
    netSpent: row.netSpent.toString(),
  };
}

export type SerialisedTalentRow = ReturnType<typeof serialise>;
