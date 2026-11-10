/// Who to work with.
///
/// Every number here is read from the registry, where it is written once per settled job. Nothing
/// is derived by scanning jobs and nothing is stored off chain, so this page cannot disagree with
/// the chain — the whole file is a sort over `profileOf` rows.
///
/// The boards are deliberately counts, not grades. There is no composite 0–100 trust score,
/// because nobody could verify one: what a reader can check is "nine jobs paid, one ticket lost",
/// which is exactly what is shown.

import type { Profile } from "./contract";

export type TalentRow = {
  address: `0x${string}`;
  name: string;
  kind: number;
  /// Worker side. `jobsDone` is the escrow's own definition: the employer released, or the worker
  /// won the ticket. A lost ticket and a walk-away both count against.
  jobsDone: number;
  /// Tickets are counted per address, not per side: a profile's `ticketsWon` is "rulings that went
  /// this wallet's way", whichever side it was on. A single address that employed on one job and
  /// worked on another merges both, so these are never split by role.
  ticketsWon: number;
  ticketsLost: number;
  abandoned: number;
  receivedAsWorker: bigint;
  bondedAsWorker: bigint;
  netEarned: bigint;
  /// Employer side. `jobsPosted` is jobs settled as the employer.
  jobsPosted: number;
  stakedAsEmployer: bigint;
  receivedAsEmployer: bigint;
  netSpent: bigint;
  /// Filing fees, whoever filed. Real spend, but not payment for work, so it is never folded into
  /// either side's net.
  feesPaid: bigint;
  /// Jobs this wallet settled at all, as either side. The registry pushes a settled job id into both
  /// parties' histories once, and `require(worker != employer)` means the sides never overlap, so
  /// `worked = settledJobs − jobsPosted` is exact rather than derived from a guess.
  settledJobs: number;
  worked: number;
  /// The sortable units, one line each. `null` means this wallet has no history on that side at
  /// all, so there is nothing to rank — not zero, and deliberately not a negative number.
  workerUnits: number | null;
  employerUnits: number | null;
  /// True when the wallet has settled jobs on both sides *and* a ticket loss it lost. `ticketsLost`
  /// is one counter per address, so in that case the loss cannot be attributed to a side and is
  /// charged on both — the conservative reading, flagged rather than hidden.
  mixedSides: boolean;
};

export type BoardKey = "workers" | "employers" | "earners" | "payers" | "disputes";

export const BOARDS: {
  key: BoardKey;
  label: string;
  blurb: string;
  /// What the rank means, in one sentence, shown under the tabs.
  formula: string;
}[] = [
  {
    key: "workers",
    label: "workers",
    blurb: "who delivers",
    formula: "jobs done − tickets lost − abandoned. A worker who wins one and loses one ranks below one who wins one.",
  },
  {
    key: "employers",
    label: "employers",
    blurb: "who pays",
    formula: "settled jobs posted − tickets lost. An employer who loses a complaint stops climbing.",
  },
  {
    key: "earners",
    label: "earners",
    blurb: "most WIF received",
    formula: "WIF credited as a worker minus the bond they staked. The bond coming back is not income.",
  },
  {
    key: "payers",
    label: "payers",
    blurb: "most WIF paid out",
    formula: "price staked minus refunds received, as an employer. Filing fees are shown beside it — real spend, but not payment for work.",
  },
  {
    key: "disputes",
    label: "disputes",
    blurb: "who argues and who wins",
    formula: "tickets won, then tickets lost. Ranked by wins; losses are shown beside them.",
  },
];

export function toRow(address: `0x${string}`, profile: Profile, settledJobs: number): TalentRow {
  const jobsDone = profile.jobsDone;
  const ticketsLost = profile.ticketsLost;
  const abandoned = profile.abandoned;
  /// `bondedAsWorker` only moves inside `record()`, so it is exactly "has this wallet ever had a
  /// settled job as a worker" — bond returned, bond forfeited, or a walk-away.
  const workedOnce = profile.bondedAsWorker > 0n;
  const employedOnce = profile.jobsPosted > 0;
  return {
    address,
    name: profile.name,
    kind: profile.kind,
    jobsDone,
    ticketsWon: profile.ticketsWon,
    ticketsLost,
    abandoned,
    receivedAsWorker: profile.receivedAsWorker,
    bondedAsWorker: profile.bondedAsWorker,
    netEarned: profile.receivedAsWorker - profile.bondedAsWorker,
    jobsPosted: profile.jobsPosted,
    stakedAsEmployer: profile.stakedAsEmployer,
    receivedAsEmployer: profile.receivedAsEmployer,
    netSpent: profile.stakedAsEmployer - profile.receivedAsEmployer,
    feesPaid: profile.feesPaid,
    settledJobs,
    worked: Math.max(0, settledJobs - profile.jobsPosted),
    workerUnits: workedOnce ? jobsDone - ticketsLost - abandoned : null,
    employerUnits: employedOnce ? profile.jobsPosted - ticketsLost : null,
    mixedSides: workedOnce && employedOnce && ticketsLost > 0,
  };
}

/// Deterministic total order: the unit, then the thing it was made of, then value, then the
/// address. The address tiebreak keeps pagination stable when two wallets are identical.
function compare(board: BoardKey): (a: TalentRow, b: TalentRow) => number {
  const byAddress = (a: TalentRow, b: TalentRow) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1);
  const worker = (a: TalentRow, b: TalentRow) => (b.workerUnits ?? 0) - (a.workerUnits ?? 0);
  const employer = (a: TalentRow, b: TalentRow) => (b.employerUnits ?? 0) - (a.employerUnits ?? 0);
  switch (board) {
    case "workers":
      return (a, b) => worker(a, b) || b.jobsDone - a.jobsDone || cmpBig(b.netEarned, a.netEarned) || byAddress(a, b);
    case "employers":
      return (a, b) => employer(a, b) || b.jobsPosted - a.jobsPosted || cmpBig(b.netSpent, a.netSpent) || byAddress(a, b);
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

function cmpBig(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

/// The counters a board ranks on, shared so the page and the API cannot disagree about who is
/// rankable. Deliberately no amounts: a row whose wei has been serialised to strings still fits.
export type BoardInputs = Pick<
  TalentRow,
  "workerUnits" | "employerUnits" | "jobsDone" | "jobsPosted" | "abandoned" | "ticketsWon" | "ticketsLost"
>;

/// Whether a row has anything to rank on for this board. A wallet with no settled job is still
/// findable — a new agent has to be discoverable or it can never be hired — but it sorts last and
/// is flagged rather than pretending to a rank it has not earned.
export function isRanked(row: BoardInputs, board: BoardKey): boolean {
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

export type TalentQuery = {
  board?: BoardKey;
  /// Address prefix, or any part of a username. Case-insensitive.
  q?: string;
  /// 0 human, 1 AI, undefined for both.
  kind?: number;
};

export function rankTalents(rows: TalentRow[], query: TalentQuery): { rows: TalentRow[]; total: number } {
  const board = query.board ?? "workers";
  const needle = (query.q ?? "").trim().toLowerCase();

  const filtered = rows.filter((row) => {
    if (query.kind !== undefined && row.kind !== query.kind) return false;
    if (!needle) return true;
    if (row.name.toLowerCase().includes(needle)) return true;
    return needle.startsWith("0x") ? row.address.toLowerCase().includes(needle) : needle.length < 4 ? false : row.address.toLowerCase().includes(needle);
  });

  const ranked = filtered.filter((row) => isRanked(row, board)).sort(compare(board));
  const unranked = filtered.filter((row) => !isRanked(row, board)).sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1,
  );

  return { rows: [...ranked, ...unranked], total: filtered.length };
}
