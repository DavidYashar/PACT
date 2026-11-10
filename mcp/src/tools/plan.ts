import { config, BOND_BPS, BPS, FILING_FEE_BPS, STATE_NAME, SUPERSEDE_COOLDOWN_MS, State, type Address } from "../config.js";
import { escrowAbi, namesAbi, wifAbi } from "../abi.js";
import {
  client,
  isRegistered,
  ownerOfName,
  pendingNonce,
  readAllowance,
  readBids,
  readClaimable,
  readJob,
  readRecordedFor,
  readResolver,
  readMinCountedPrice,
  readWifBalance,
} from "../chain.js";
import { buildStep, expectedCall } from "../validate.js";
import { createIntent, newestPendingIntent, reserveNonces, type Intent, type Step } from "../intents.js";
import { termsDigest, textDigest, type Terms } from "../content.js";
import { PERMIT2, PERMIT2_ABI, ERC20_ABI, ROUTER_ABI, UNIVERSAL_ROUTER, encodeSwap, poolFor, quoteExactIn, withSlippage } from "../swap.js";

export type PlanRefusal = { ok: false; reason: string; fix?: string; retryAfterMs?: number };
export type PlanSuccess = { ok: true; intent: Intent; superseded: number };

const RESERVED = new Set(["pact", "admin", "treasury", "resolver", "support", "official"]);

export function normalizeName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().toLowerCase();
  if (name.length < 3) return { error: "a username needs at least 3 characters" };
  if (name.length > 20) return { error: "a username can be at most 20 characters" };
  if (!/^[a-z0-9_]+$/.test(name)) return { error: "a username may only use letters, numbers and underscore" };
  if (RESERVED.has(name)) return { error: `"${name}" is reserved by the platform` };
  return { name };
}

function short(amount: bigint): string {
  return (Number(amount) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

const TERM_LIMITS = {
  title: 120,
  description: 4000,
  criteria: 2000,
  proofSpec: 1000,
  category: 40,
} as const;

/// Terms are the job's contract: what must be delivered, by when, and what counts as proof.
/// They are hashed, so every character is permanent. Bounds here keep a model from submitting a
/// wall of text that no resolver will read, and keep the digest reproducible across surfaces.
function checkTerms(input: Terms): { terms: Terms } | { error: string } {
  const terms = {} as Terms;
  for (const field of Object.keys(TERM_LIMITS) as (keyof typeof TERM_LIMITS)[]) {
    const raw = input?.[field];
    if (typeof raw !== "string") return { error: `terms.${field} must be a string` };
    /// Kept exactly as given, because this text is hashed: trimming would mean two parties hashing
    /// the same words get different commitments depending on trailing whitespace.
    if (!raw.trim()) return { error: `terms.${field} cannot be empty` };
    if (raw.length > TERM_LIMITS[field]) {
      return { error: `terms.${field} can be at most ${TERM_LIMITS[field]} characters` };
    }
    terms[field] = raw;
  }
  /// Optional, and validated here rather than at delivery time: a malformed commitment would
  /// otherwise be discovered only after the work was done, when it can no longer be renegotiated.
  const expected = (input as Terms).expectedProofHash;
  if (expected !== undefined) {
    if (typeof expected !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(expected)) {
      return { error: "terms.expectedProofHash must be a 32-byte hex digest, or omitted" };
    }
    if (/^0x0{64}$/.test(expected)) {
      return { error: "terms.expectedProofHash cannot be all zeroes; omit it if you do not have one" };
    }
    terms.expectedProofHash = expected.toLowerCase() as `0x${string}`;
  }
  return { terms };
}

async function chainNow(): Promise<bigint> {
  const block = await client.getBlock({ blockTag: "latest" });
  return block.timestamp;
}

/// The silence window is a per-job choice now, so the plan needs the deployment default and the
/// stale-job grace from the contract rather than a hard-coded number.
async function readStaleJobGrace(): Promise<bigint | null> {
  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "staleJobGrace",
    })) as bigint;
  } catch {
    return null;
  }
}

async function readDisputeTimeout(): Promise<bigint | null> {
  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "disputeTimeout",
    })) as bigint;
  } catch {
    return null;
  }
}

async function readAutoReleaseDelay(): Promise<bigint | null> {  try {
    return (await client.readContract({
      address: config.escrow,
      abi: escrowAbi,
      functionName: "defaultAutoReleaseDelay",
    })) as bigint;
  } catch {
    return null;
  }
}

export async function plan(params: {
  action: string;
  address: Address;
  name?: string;
  kind?: number;
  amount?: string;
  terms?: Terms;
  termsHash?: string;
  pitch?: string;
  budget?: string;
  bidDeadline?: number;
  deliveryDeadline?: number;
  autoReleaseSeconds?: number;
  jobId?: number;
  price?: string;
  bidIndex?: number;
  worker?: string;
  proof?: string;
  proofHash?: string;
  reason?: string;
  reasonHash?: string;
  ruling?: string;
  fineBps?: number;
  side?: "buy" | "sell";
  amountIn?: string;
  slippageBps?: number;
  deadlineSeconds?: number;
  note?: string;
}): Promise<PlanSuccess | PlanRefusal> {
  const address = params.address;

  /// One live plan per wallet, and no replacing it within the cooldown: otherwise a caller can flip
  /// an agent's plan out from under a signature it is about to send. The check reads the ledger, so
  /// a refused plan — wrong size, missing allowance, closed window — leaves nothing behind to wait
  /// for. An agent looping on sizes is paced by the chain, not by its own failed attempts.
  const livePlan = await newestPendingIntent(address);
  if (livePlan) {
    const ageMs = Date.now() - livePlan.createdAt.getTime();
    if (ageMs < SUPERSEDE_COOLDOWN_MS) {
      const waitMs = SUPERSEDE_COOLDOWN_MS - ageMs;
      return {
        ok: false,
        reason:
          `your plan ${livePlan.id} (${livePlan.action}) was prepared ${Math.floor(ageMs / 1000)}s ago ` +
          `and is still pending; it was not submitted`,
        fix: `submit it with pact_submit, or plan again in ${Math.ceil(waitMs / 1000)}s`,
        retryAfterMs: waitMs,
      };
    }
  }

  const registered = await isRegistered(address);

  const now = await chainNow();
  const calls: {
    label: string;
    to: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    value?: bigint;
  }[] = [];
  const cheque: Record<string, unknown> = {};
  let summary = "";

  switch (params.action) {
    case "register": {
      if (registered) {
        return { ok: false, reason: "this wallet already has a username", fix: "usernames are permanent; nothing to do" };
      }
      if (!params.name) return { ok: false, reason: "name is required" };
      const parsed = normalizeName(params.name);
      if ("error" in parsed) return { ok: false, reason: parsed.error };
      const taken = await ownerOfName(parsed.name);
      if (taken) return { ok: false, reason: `"${parsed.name}" is already taken`, fix: "pick another name" };

      const kind = params.kind === 1 ? 1 : 0;
      calls.push({
        label: `register @${parsed.name}`,
        to: config.names,
        abi: namesAbi,
        functionName: "register",
        args: [parsed.name, kind],
      });
      cheque.name = parsed.name;
      cheque.kind = kind === 1 ? "AI" : "HUMAN";
      summary = `claim the username @${parsed.name} as ${kind === 1 ? "an AI agent" : "a human"}`;
      break;
    }

    case "approve": {
      if (!params.amount) return { ok: false, reason: "amount is required, in wei" };
      let amount: bigint;
      try {
        amount = BigInt(params.amount);
      } catch {
        return { ok: false, reason: "amount must be a whole number of wei" };
      }
      if (amount <= 0n) return { ok: false, reason: "amount must be greater than zero" };

      calls.push({
        label: `approve ${short(amount)} WIF to the escrow`,
        to: config.wif,
        abi: wifAbi,
        functionName: "approve",
        args: [config.escrow, amount],
      });
      cheque.amount = amount.toString();
      summary = `allow the escrow to move ${short(amount)} WIF from this wallet`;
      break;
    }

    case "post_job": {
      if (!registered) {
        return { ok: false, reason: "this wallet has no username", fix: "plan and submit `register` first" };
      }

      /// Terms are text here, not a hash. An agent that has to compute keccak itself will
      /// eventually publish terms that do not match the value it committed, and the mismatch
      /// only shows up after the money is locked. So the server hashes, and publishes the same
      /// text after the receipt lands.
      let terms: Terms | undefined;
      let termsHash = params.termsHash;
      if (params.terms) {
        const checked = checkTerms(params.terms);
        if ("error" in checked) return { ok: false, reason: checked.error };
        terms = checked.terms;
        const digest = termsDigest(terms);
        if (termsHash && termsHash.toLowerCase() !== digest.toLowerCase()) {
          return {
            ok: false,
            reason: "termsHash does not match the digest of the terms you supplied",
            fix: `the digest of these terms is ${digest}`,
          };
        }
        termsHash = digest;
      }

      if (!termsHash || !/^0x[0-9a-fA-F]{64}$/.test(termsHash)) {
        return {
          ok: false,
          reason: "post_job needs either `terms` (the text) or `termsHash` (a 32-byte commitment)",
          fix: "pass terms: { title, description, criteria, proofSpec, category }",
        };
      }
      let budget: bigint;
      try {
        budget = BigInt(params.budget ?? "0");
      } catch {
        return { ok: false, reason: "budget must be a whole number of wei" };
      }
      if (budget <= 0n) return { ok: false, reason: "budget must be greater than zero" };

      /// The silence window belongs to the job, because a bidder prices it: a worker who will be
      /// paid automatically after an hour is taking a different job from one who waits a fortnight.
      /// The escrow bounds it, so an out-of-range value is refused here rather than reverted there.
      const MIN_AUTO_RELEASE = 60n;
      const MAX_AUTO_RELEASE = 365n * 24n * 60n * 60n;
      let autoRelease: bigint;
      try {
        autoRelease = BigInt(params.autoReleaseSeconds ?? (await readAutoReleaseDelay()) ?? 14 * 24 * 60 * 60);
      } catch {
        return { ok: false, reason: "autoReleaseSeconds must be a whole number of seconds" };
      }
      if (autoRelease < MIN_AUTO_RELEASE || autoRelease > MAX_AUTO_RELEASE) {
        return {
          ok: false,
          reason: `autoReleaseSeconds must be between ${MIN_AUTO_RELEASE} and ${MAX_AUTO_RELEASE} seconds`,
          fix: "omit it to use the deployment default",
        };
      }
      if (!params.bidDeadline || !params.deliveryDeadline) {
        return { ok: false, reason: "bidDeadline and deliveryDeadline are required (unix seconds)" };
      }
      if (BigInt(params.bidDeadline) <= now) {
        return { ok: false, reason: "bidDeadline is already in the past" };
      }
      if (BigInt(params.deliveryDeadline) <= BigInt(params.bidDeadline)) {
        return { ok: false, reason: "deliveryDeadline must be after bidDeadline" };
      }

      const balance = await readWifBalance(address);
      if (balance < budget) {
        return {
          ok: false,
          reason: `this wallet holds ${short(balance)} WIF and the budget is ${short(budget)} WIF`,
          fix: "top up the wallet, then plan this again",
        };
      }

      const allowance = await readAllowance(address, config.escrow);
      /// Top up, never replace. An ERC-20 allowance is one number shared by every escrow spend, so
      /// approving exactly `budget` here would silently cancel an outstanding bond approval the
      /// same wallet made for a bid. The agent would then be unable to accept a bid it won, with
      /// nothing on chain explaining why.
      if (allowance < budget) {
        calls.push({
          label: `top up the escrow allowance to ${short(allowance + budget)} WIF`,
          to: config.wif,
          abi: wifAbi,
          functionName: "approve",
          args: [config.escrow, allowance + budget],
        });
      }
      calls.push({
        label: `post the job, escrowing ${short(budget)} WIF`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "postJob",
        args: [termsHash, budget, BigInt(params.bidDeadline), BigInt(params.deliveryDeadline), autoRelease],
      });
      cheque.budget = budget.toString();
      cheque.termsHash = termsHash;
      cheque.autoReleaseDelay = autoRelease.toString();
      if (terms) cheque.terms = terms;
      summary = `post a job with a ${short(budget)} WIF budget, bidding until ${new Date(
        Number(params.bidDeadline) * 1000,
      ).toISOString()} and delivery due ${new Date(Number(params.deliveryDeadline) * 1000).toISOString()}`;
      summary += `; if you stay silent for ${Math.round(Number(autoRelease) / 60)} minutes after delivery, anyone can pay the worker`;
      if (terms) summary += ` — "${terms.title}"`;
      /// The floor is a constant in the registry, so it is read rather than repeated here: a job
      /// under it settles and pays in full but buys no rank, and an employer must know that before
      /// signing, not after noticing an empty profile.
      const counted = await readMinCountedPrice();
      if (counted !== undefined && budget < counted) {
        summary += `. ${short(counted)} WIF is the smallest job the registry counts: this one will settle and pay, but it moves no reputation counter and enters neither party's history`;
      }
      if (terms?.expectedProofHash) {
        summary += `. This job is self-verifying: only a delivery whose digest is ${terms.expectedProofHash} can be approved, so there is nothing for a resolver to decide`;
      }
      break;
    }

    case "bid": {
      if (!registered) {
        return { ok: false, reason: "this wallet has no username", fix: "plan and submit `register` first" };
      }
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      let price: bigint;
      try {
        price = BigInt(params.price ?? "0");
      } catch {
        return { ok: false, reason: "price must be a whole number of wei" };
      }
      if (price <= 0n) return { ok: false, reason: "price must be greater than zero" };

      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.OPEN) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, not OPEN` };
      }
      if (BigInt(job.bidDeadline) <= now) {
        return { ok: false, reason: "the bidding window on this job has closed" };
      }
      if (job.employer.toLowerCase() === address.toLowerCase()) {
        return { ok: false, reason: "this wallet posted the job; it cannot bid on it" };
      }
      if (price > job.budget) {
        return { ok: false, reason: `price ${short(price)} WIF is above the ${short(job.budget)} WIF budget` };
      }

      const bond = (price * BOND_BPS) / BPS;
      if (bond === 0n) return { ok: false, reason: "price is too small to produce a bond" };

      /// A second bid on the same job only creates ambiguity, and the contract allows it.
      /// Refuse it here so a retry cannot quietly double a commitment.
      const existing = (await readBids(jobId)).find((b) => b.worker.toLowerCase() === address.toLowerCase());
      if (existing) {
        return {
          ok: false,
          reason: `this wallet already bid ${short(existing.price)} WIF on job ${params.jobId}`,
          fix: "a bid cannot be withdrawn or replaced; wait for the employer to decide",
        };
      }

      const balance = await readWifBalance(address);
      if (balance < bond) {
        return {
          ok: false,
          reason: `the bond for a ${short(price)} WIF bid is ${short(bond)} WIF, and this wallet holds ${short(balance)} WIF`,
          fix: "lower the price or top up the wallet",
        };
      }

      const allowance = await readAllowance(address, config.escrow);
      if (allowance < bond) {
        calls.push({
          label: `top up the escrow allowance to ${short(allowance + bond)} WIF`,
          to: config.wif,
          abi: wifAbi,
          functionName: "approve",
          args: [config.escrow, allowance + bond],
        });
      }
      calls.push({
        label: `bid ${short(price)} WIF on job ${params.jobId}`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "bid",
        args: [jobId, price],
      });
      cheque.price = price.toString();
      cheque.bond = bond.toString();
      cheque.jobId = params.jobId;
      if (params.pitch) {
        const pitch = params.pitch.trim();
        if (pitch.length > 2000) return { ok: false, reason: "a pitch can be at most 2000 characters" };
        cheque.pitch = pitch;
      }
      summary = `bid ${short(price)} WIF on job ${params.jobId}, locking a ${short(bond)} WIF bond when the employer accepts`;
      break;
    }

    case "cancel": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.employer.toLowerCase() !== address.toLowerCase()) {
        return { ok: false, reason: "only the employer can cancel this job" };
      }
      if (job.state !== State.OPEN) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and only an OPEN job can be cancelled` };
      }
      calls.push({
        label: `cancel job ${params.jobId} and refund ${short(job.budget)} WIF to claimable`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "cancelJob",
        args: [jobId],
      });
      cheque.jobId = params.jobId;
      cheque.refund = job.budget.toString();
      summary = `cancel job ${params.jobId}; the ${short(job.budget)} WIF budget becomes claimable to you, and no bid can be accepted`;
      break;
    }

    case "accept": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.employer.toLowerCase() !== address.toLowerCase()) {
        return { ok: false, reason: "only the employer can accept a bid" };
      }
      if (job.state !== State.OPEN) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, not OPEN` };
      }
      /// Acceptance is bounded by the bid window on chain. Checking here means the refusal explains
      /// itself instead of the signed transaction reverting with BidWindowClosed.
      if (now >= Number(job.bidDeadline)) {
        return {
          ok: false,
          reason: `job ${params.jobId} closed for bids at ${new Date(Number(job.bidDeadline) * 1000).toISOString()}, so no bid can be accepted now`,
          fix: "anyone can reclaim an open job past its window with cancel_expired",
        };
      }

      const bids = await readBids(jobId);
      let index = -1;
      if (typeof params.bidIndex === "number") {
        index = params.bidIndex;
      } else if (params.worker) {
        index = bids.findIndex((b) => b.worker.toLowerCase() === params.worker!.toLowerCase());
        if (index < 0) {
          return { ok: false, reason: `${params.worker} has not bid on job ${params.jobId}`, fix: "read the bids with get_job" };
        }
      } else {
        return { ok: false, reason: "accept needs `bidIndex` or `worker` to know which bid" };
      }
      if (index < 0 || index >= bids.length) {
        return { ok: false, reason: `there is no bid index ${index} on job ${params.jobId}`, fix: `${bids.length} bid(s) exist, numbered from 0` };
      }

      const bid = bids[index];
      if (bid.accepted) return { ok: false, reason: "that bid is already accepted" };
      if (bid.withdrawn) {
        return {
          ok: false,
          reason: "that bid was withdrawn by its worker, so it is no longer an offer",
          fix: "accept a different bid, or ask the worker to bid again",
        };
      }
      const bond = (bid.price * BOND_BPS) / BPS;
      if (bond === 0n) return { ok: false, reason: "that bid is too small to produce a bond" };

      /// The contract pulls the worker's bond inside this transaction. If the worker cannot fund
      /// it, the employer's own transaction reverts and the employer pays the gas. Check first.
      const [workerBalance, workerAllowance] = await Promise.all([
        readWifBalance(bid.worker),
        readAllowance(bid.worker, config.escrow),
      ]);
      if (workerBalance < bond) {
        return {
          ok: false,
          reason: `the bond for this bid is ${short(bond)} WIF and ${bid.worker} holds ${short(workerBalance)} WIF`,
          fix: "accept a different bid, or ask this worker to top up",
        };
      }
      if (workerAllowance < bond) {
        return {
          ok: false,
          reason: `${bid.worker} has approved ${short(workerAllowance)} WIF to the escrow and the bond is ${short(bond)} WIF`,
          fix: "the worker must approve at least the bond amount before this bid can be accepted",
        };
      }

      calls.push({
        label: `accept bid ${index}: ${short(bid.price)} WIF from ${bid.worker}`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "acceptBid",
        args: [jobId, BigInt(index)],
      });
      cheque.jobId = params.jobId;
      cheque.bidIndex = index;
      cheque.price = bid.price.toString();
      cheque.bond = bond.toString();
      summary =
        `accept ${bid.worker}'s bid of ${short(bid.price)} WIF. Their ${short(bond)} WIF bond is pulled in ` +
        `this transaction, ${short(job.budget - bid.price)} WIF of surplus budget becomes claimable to you, ` +
        `and delivery is due ${new Date(Number(job.deliveryDeadline) * 1000).toISOString()}`;
      break;
    }

    case "release": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const job = await readJob(BigInt(params.jobId));
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.employer.toLowerCase() !== address.toLowerCase()) {
        return { ok: false, reason: "only the employer can release this job" };
      }
      if (job.state !== State.DELIVERED) {
        return {
          ok: false,
          reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and only a DELIVERED job can be released`,
        };
      }
      const cut = (job.price * 500n) / BPS;
      calls.push({
        label: `release ${short(job.price)} WIF of escrow to the worker`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "approveDelivery",
        args: [BigInt(params.jobId)],
      });
      cheque.jobId = params.jobId;
      summary =
        `release the escrow: the worker is credited ${short(job.price - cut)} WIF plus their ${short(job.bond)} WIF bond, ` +
        `and ${short(cut)} WIF goes to the treasury. Nobody is paid yet — the contract credits a balance that must be ` +
        `withdrawn with \`settle\` after the job is inscribed. You cannot undo this.`;
      break;
    }

    case "deliver": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.worker.toLowerCase() !== address.toLowerCase()) {
        return { ok: false, reason: "only the worker on this job can deliver it" };
      }
      if (job.state !== State.ASSIGNED) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, not ASSIGNED` };
      }
      /// Never commit to a deadline boundary: blocks land ~250ms apart, but a queued transaction
      /// can still arrive late, and a delivery that misses by one second is a failed delivery.
      if (now + 15n >= job.deliveryDeadline) {
        return {
          ok: false,
          reason: `the delivery deadline (${new Date(Number(job.deliveryDeadline) * 1000).toISOString()}) is too close for a transaction to land in time`,
          fix: "the deadline has effectively passed; a ticket is the only remaining route",
        };
      }

      let proofHash = params.proofHash;
      /// Hash exactly what was sent. Trimming first would mean a party who hashes their own file
      /// gets a different digest from the one the escrow holds, and the only conclusion available to
      /// them is that the deliverable was swapped. Whitespace is the submitter's business.
      const proof = params.proof;
      if (proof !== undefined) {
        if (proof.trim().length < 20) return { ok: false, reason: "a deliverable description needs at least 20 characters" };
        if (proof.length > 20_000) return { ok: false, reason: "a deliverable can be at most 20,000 characters" };
        proofHash = textDigest(proof);
      }
      if (!proofHash || !/^0x[0-9a-fA-F]{64}$/.test(proofHash)) {
        return {
          ok: false,
          reason: "deliver needs the deliverable itself as `proof`, or a 32-byte `proofHash`",
          fix: "pass proof: \"the URL, the screenshots, what you shipped\"",
        };
      }

      calls.push({
        label: "commit the deliverable",
        to: config.escrow,
        abi: escrowAbi,
        functionName: "submitDelivery",
        args: [jobId, proofHash],
      });
      cheque.jobId = params.jobId;
      cheque.proofHash = proofHash;
      if (proof) cheque.proof = proof;
      summary =
        `commit the deliverable to job ${params.jobId}. This starts this job's own silence clock ` +
        `(${Math.round(Number(job.autoReleaseDelay) / 60)} minutes): if the employer does nothing, ` +
        `the money releases to you at ${new Date((Number(now) + Number(job.autoReleaseDelay)) * 1000).toISOString()}`;
      break;
    }

    case "raise_ticket": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.ASSIGNED && job.state !== State.DELIVERED) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and a ticket needs it ASSIGNED or DELIVERED` };
      }
      const isEmployer = job.employer.toLowerCase() === address.toLowerCase();
      const isWorker = job.worker.toLowerCase() === address.toLowerCase();
      if (!isEmployer && !isWorker) return { ok: false, reason: "only the employer or the worker can file a ticket" };

      let reasonHash = params.reasonHash;
      const reason = params.reason;
      if (reason !== undefined) {
        if (reason.trim().length < 20) return { ok: false, reason: "a complaint needs at least 20 characters" };
        if (reason.length > 10_000) return { ok: false, reason: "a complaint can be at most 10,000 characters" };
        reasonHash = textDigest(reason);
      }
      if (!reasonHash || !/^0x[0-9a-fA-F]{64}$/.test(reasonHash)) {
        return { ok: false, reason: "raise_ticket needs the complaint as `reason`, or a 32-byte `reasonHash`" };
      }

      const fee = (job.price * FILING_FEE_BPS) / BPS;
      const feeSource = isEmployer
        ? "new WIF from your wallet"
        : `your own bond, which falls from ${short(job.workerEscrow)} WIF to ${short(job.workerEscrow - fee)} WIF`;
      if (isEmployer) {
        const [balance, allowance] = await Promise.all([
          readWifBalance(address),
          readAllowance(address, config.escrow),
        ]);
        if (balance < fee) {
          return { ok: false, reason: `filing costs ${short(fee)} WIF and this wallet holds ${short(balance)} WIF` };
        }
        /// The fee is pulled as new WIF, so an employer who has spent their allowance down (for
        /// instance by posting a job) needs a top-up first. Top up, never replace.
        if (allowance < fee) {
          calls.push({
            label: `top up the escrow allowance to ${short(allowance + fee)} WIF for the filing fee`,
            to: config.wif,
            abi: wifAbi,
            functionName: "approve",
            args: [config.escrow, allowance + fee],
          });
        }
      } else if (job.workerEscrow < fee) {
        return {
          ok: false,
          reason: `filing costs ${short(fee)} WIF from a bond of ${short(job.workerEscrow)} WIF, which is not enough`,
        };
      }

      calls.push({
        label: `file a ticket on job ${params.jobId}`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "raiseDispute",
        args: [jobId, reasonHash],
      });
      cheque.jobId = params.jobId;
      cheque.reasonHash = reasonHash;
      cheque.fee = fee.toString();
      if (reason) cheque.reason = reason;
      summary =
        `file a ticket. It costs ${short(fee)} WIF out of ${feeSource}, it is not refundable, and it freezes both ` +
        `stakes until the resolver rules. Auto-release stops the moment this lands.`;
      break;
    }

    case "resolve": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };

      const resolver = await readResolver();
      if (!resolver || resolver.toLowerCase() !== address.toLowerCase()) {
        return { ok: false, reason: "only the resolver can rule on a ticket" };
      }
      if (job.state !== State.DISPUTED) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, not DISPUTED` };
      }
      if (job.employer.toLowerCase() === address.toLowerCase() || job.worker.toLowerCase() === address.toLowerCase()) {
        return { ok: false, reason: "the resolver is a party to this job and cannot rule on it" };
      }

      const ruling = (params.ruling ?? "").toLowerCase();
      if (ruling !== "worker" && ruling !== "employer") {
        return { ok: false, reason: 'ruling must be "worker" or "employer"', fix: "there is no third option, and no address to pay" };
      }
      const fineBps = params.fineBps ?? 0;
      if (!Number.isInteger(fineBps) || fineBps < 0 || fineBps > 1000) {
        return { ok: false, reason: "fineBps must be an integer between 0 and 1000" };
      }

      calls.push({
        label: `rule for the ${ruling}, fine ${fineBps} bps`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "resolveDispute",
        args: [jobId, ruling === "worker" ? 0 : 1, fineBps],
      });
      cheque.jobId = params.jobId;
      cheque.ruling = ruling;
      cheque.fineBps = fineBps;
      if (params.note) cheque.note = params.note.trim().slice(0, 4000);
      summary =
        `rule for the ${ruling}. The money moves between the two parties already in job ${params.jobId} and the treasury; ` +
        `nothing can be sent anywhere else`;
      break;
    }

    case "settle": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };

      const isParty =
        job.employer.toLowerCase() === address.toLowerCase() || job.worker.toLowerCase() === address.toLowerCase();

      /// Recording is what makes the settlement permanent and public, and the escrow will not
      /// release a claim until it happens. Either party can do it, which is how an absent
      /// counterparty cannot strand the other's money.
      const recorded = job.state === State.SETTLED ? await readRecordedFor(jobId) : true;
      if (job.state === State.SETTLED && !recorded) {
        if (!isParty) return { ok: false, reason: "only the employer or the worker can record this job" };
        calls.push({
          label: `inscribe job ${params.jobId} in the record`,
          to: config.names,
          abi: namesAbi,
          functionName: "record",
          args: [jobId],
        });
      }

      const claimable = await readClaimable(address);
      if (claimable > 0n) {
        calls.push({
          label: `claim ${short(claimable)} WIF`,
          to: config.escrow,
          abi: escrowAbi,
          functionName: "claim",
          args: [],
        });
      }

      if (calls.length === 0) {
        return {
          ok: false,
          reason:
            job.state !== State.SETTLED
              ? `nothing to settle for job ${params.jobId}: it is ${STATE_NAME[job.state]}, so no money is owed yet`
              : `nothing to settle for job ${params.jobId}: it is already recorded and this wallet has no claimable balance`,
        };
      }

      cheque.jobId = params.jobId;
      cheque.claimable = claimable.toString();
      cheque.claims = claimable > 0n;
      summary = [
        job.state === State.SETTLED && !recorded ? `inscribe job ${params.jobId}` : null,
        claimable > 0n
          ? `claim ${short(claimable)} WIF (wallet-wide: this withdraws every credit this wallet is owed, not only this job's)`
          : null,
      ]
        .filter(Boolean)
        .join(" and ");
      break;
    }

    case "abandon": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const job = await readJob(BigInt(params.jobId));
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.worker.toLowerCase() !== address.toLowerCase()) {
        return { ok: false, reason: "only the worker can abandon this job" };
      }
      if (job.state !== State.ASSIGNED) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, not ASSIGNED` };
      }
      calls.push({
        label: `abandon job ${params.jobId}`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "abandonJob",
        args: [BigInt(params.jobId)],
      });
      cheque.jobId = params.jobId;
      summary =
        `abandon job ${params.jobId}. Your entire ${short(job.workerEscrow)} WIF bond goes to the employer, ` +
        `their price comes back to them, and the treasury takes its cut. This is final.`;
      break;
    }

    case "release_expired": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const job = await readJob(BigInt(params.jobId));
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.DELIVERED) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, not DELIVERED` };
      }
      if (now < job.autoReleaseAt) {
        return {
          ok: false,
          reason: `the auto-release window closes at ${new Date(Number(job.autoReleaseAt) * 1000).toISOString()}`,
          fix: "anyone may call this then, not just the worker",
        };
      }
      calls.push({
        label: `release job ${params.jobId} after the auto-release window`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "releaseExpired",
        args: [BigInt(params.jobId)],
      });
      cheque.jobId = params.jobId;
      summary = `release job ${params.jobId}: the employer stayed silent past the window, so the money goes to the worker`;
      break;
    }

    case "cancel_expired": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const job = await readJob(BigInt(params.jobId));
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.OPEN) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and only an OPEN job can expire` };
      }
      const grace = await readStaleJobGrace();
      const staleAt = Number(job.bidDeadline) + Number(grace ?? 0n);
      if (now < staleAt) {
        return {
          ok: false,
          reason: `job ${params.jobId} is still within its window: nobody can reclaim it before ${new Date(staleAt * 1000).toISOString()}`,
          fix: "the employer can cancel it now; after that timestamp anyone can",
        };
      }
      calls.push({
        label: `reclaim job ${params.jobId}: its window closed ${grace}s ago or more`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "cancelExpiredJob",
        args: [BigInt(params.jobId)],
      });
      cheque.jobId = params.jobId;
      summary =
        `reclaim job ${params.jobId}. Its bidding window closed and nobody won it, so the ${short(job.budget)} WIF budget returns to the employer. ` +
        `You are doing them a favour, not taking anything: no money goes to you`;
      break;
    }

    case "reclaim_assignment": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const job = await readJob(BigInt(params.jobId));
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.ASSIGNED) {
        return {
          ok: false,
          reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and only an ASSIGNED job can be reclaimed`,
        };
      }
      const assignmentGrace = await readStaleJobGrace();
      const reclaimableAt = Number(job.deliveryDeadline) + Number(assignmentGrace ?? 0n);
      if (now < reclaimableAt) {
        return {
          ok: false,
          reason: `the worker still has until ${new Date(Number(job.deliveryDeadline) * 1000).toISOString()} to deliver, plus a grace of ${assignmentGrace ?? 0n}s`,
          fix: "after that, anyone may reclaim it; the worker can also file a ticket before then if they intend to deliver late",
        };
      }
      calls.push({
        label: `reclaim job ${params.jobId}: assigned, and the worker never delivered`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "reclaimAssignment",
        args: [BigInt(params.jobId)],
      });
      cheque.jobId = params.jobId;
      summary =
        `reclaim job ${params.jobId}. The worker was assigned and never delivered, so it settles as an abandonment: ` +
        `the ${short(job.bond)} WIF bond goes to the employer, the price is refunded, and the worker keeps nothing. ` +
        `Anyone may call this and no money goes to you`;
      break;
    }

    case "timeout_dispute": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const job = await readJob(BigInt(params.jobId));
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.DISPUTED) {
        return {
          ok: false,
          reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and a timeout only applies to a DISPUTED job`,
        };
      }
      const timeout = await readDisputeTimeout();
      const timedOutAt = Number(job.disputedAt) + Number(timeout ?? 0n);
      if (now <= BigInt(timedOutAt)) {
        return {
          ok: false,
          reason: `the resolver still has until ${new Date(timedOutAt * 1000).toISOString()} to rule on job ${params.jobId}`,
          fix: "after that anyone may settle it on the facts already on chain",
        };
      }
      calls.push({
        label: `settle job ${params.jobId}: the ticket timed out undecided`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "timeoutDispute",
        args: [BigInt(params.jobId)],
      });
      cheque.jobId = params.jobId;
      summary = job.proofHash === `0x${"0".repeat(64)}`
        ? `settle job ${params.jobId} after the ticket timed out with nothing delivered. The stakes are unwound: ` +
          `the employer's ${short(job.employerEscrow)} WIF goes back to the employer, the worker's ${short(job.workerEscrow)} WIF ` +
          `bond goes back to the worker, and nobody is marked. Anyone may call this and no money goes to you`
        : `settle job ${params.jobId} after the ticket timed out. A delivery was committed before the ticket, so it ` +
          `releases to the worker on the ordinary terms. Anyone may call this and no money goes to you`;
      break;
    }

    case "swap": {
      /// Buying and selling WIF against the Uniswap v4 pool. The route, the pool, the recipient and the
      /// slippage floor are all fixed here; the only thing the caller chooses is size and tolerance.
      const side = params.side;
      if (side !== "buy" && side !== "sell") {
        return { ok: false, reason: "swap needs side: \"buy\" or \"sell\"", fix: "buy WIF with ETH, or sell WIF for ETH" };
      }
      if (!params.amountIn || !/^[0-9]+$/.test(params.amountIn)) {
        return { ok: false, reason: "amountIn must be an integer amount in wei" };
      }

      let pool;
      try {
        pool = poolFor(config.chainId);
      } catch {
        return {
          ok: false,
          reason: `there is no WIF pool on chain ${config.chainId}`,
          fix: "the swap exists on Robinhood Chain mainnet (4663) only",
        };
      }

      const amountIn = BigInt(params.amountIn);
      if (amountIn === 0n) return { ok: false, reason: "amountIn must be greater than zero" };

      const zeroForOne = side === "buy";
      const slippageBps = params.slippageBps ?? 100;
      if (slippageBps < 0 || slippageBps > 2_000) {
        return { ok: false, reason: "slippageBps must be between 0 and 2000" };
      }

      const q = await quoteExactIn(client as never, pool, zeroForOne, amountIn);
      const amountOutMinimum = withSlippage(q.amountOut, slippageBps);

      if (zeroForOne) {
        const eth = await client.getBalance({ address });
        if (eth < amountIn) {
          return {
            ok: false,
            reason: `this wallet holds ${short(eth)} ETH and the swap needs ${short(amountIn)}`,
            fix: "top up, or swap a smaller amount",
          };
        }
      } else {
        /// The balance that matters is the token in the pool key, not whatever PACT_WIF_ADDRESS says.
        const wif = await client.readContract({
          address: pool.token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        }) as bigint;
        if (wif < amountIn) {
          return {
            ok: false,
            reason: `this wallet holds ${short(wif)} WIF and the swap needs ${short(amountIn)}`,
            fix: "swap a smaller amount, or buy WIF first",
          };
        }

        /// Selling needs two approvals, and only the ones that are actually missing. Both are for the
        /// exact amount, so nothing is left standing after the trade.
        const tokenAllowance = await client.readContract({
          address: pool.token,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, PERMIT2],
        });
        if (tokenAllowance < amountIn) {
          calls.push({
            label: `allow Permit2 to move ${short(amountIn)} WIF`,
            to: pool.token,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [PERMIT2, amountIn],
          });
        }

        const [permitAllowance, permitExpiration] = await client.readContract({
          address: PERMIT2,
          abi: PERMIT2_ABI,
          functionName: "allowance",
          args: [address, pool.token, UNIVERSAL_ROUTER],
        });
        const nowSec = Number(now);
        if (permitAllowance < amountIn || Number(permitExpiration) <= nowSec) {
          calls.push({
            label: `allow the router to pull ${short(amountIn)} WIF`,
            to: PERMIT2,
            abi: PERMIT2_ABI,
            functionName: "approve",
            args: [pool.token, UNIVERSAL_ROUTER, amountIn, nowSec + 1800],
          });
        }
      }

      const call = encodeSwap({
        pool,
        zeroForOne,
        amountIn,
        amountOutMinimum,
        deadline: now + BigInt(params.deadlineSeconds ?? 600),
      });

      calls.push({
        label:
          side === "buy"
            ? `buy WIF with ${short(amountIn)} ETH, minimum ${short(amountOutMinimum)} WIF`
            : `sell ${short(amountIn)} WIF for at least ${short(amountOutMinimum)} ETH`,
        to: call.to,
        abi: ROUTER_ABI,
        functionName: "execute",
        args: [call.commands, call.inputs, call.deadline],
        value: call.value,
      });

      cheque.side = side;
      cheque.amountIn = amountIn.toString();
      cheque.amountOut = q.amountOut.toString();
      cheque.amountOutMinimum = amountOutMinimum.toString();
      cheque.recipient = address;
      summary =
        `${side === "buy" ? "Buy WIF with" : "Sell"} ${short(amountIn)} ${side === "buy" ? "ETH" : "WIF"} through the Uniswap v4 pool. ` +
        `The output goes to ${address} and nowhere else. The pool's hook takes 1%, already included in the quote. ` +
        `Nothing else in PACT is touched by this trade`;
      break;
    }
    case "withdraw_bid": {
      if (!params.jobId || params.jobId <= 0) return { ok: false, reason: "jobId is required" };
      const jobId = BigInt(params.jobId);
      const job = await readJob(jobId);
      if (!job) return { ok: false, reason: `job ${params.jobId} does not exist` };
      if (job.state !== State.OPEN) {
        return { ok: false, reason: `job ${params.jobId} is ${STATE_NAME[job.state]}, and bids are only withdrawable while it is OPEN` };
      }
      const bids = await readBids(jobId);
      const index = bids.findIndex((b) => b.worker.toLowerCase() === address.toLowerCase() && !b.withdrawn);
      if (index < 0) return { ok: false, reason: `this wallet has no live bid on job ${params.jobId}` };

      calls.push({
        label: `withdraw bid ${index} on job ${params.jobId}`,
        to: config.escrow,
        abi: escrowAbi,
        functionName: "withdrawBid",
        args: [jobId, BigInt(index)],
      });
      cheque.jobId = params.jobId;
      cheque.bidIndex = index;
      summary = `withdraw your ${short(bids[index].price)} WIF bid on job ${params.jobId}. It stops being an offer, so it can no longer be accepted`;
      break;
    }

    default:
      return {
        ok: false,
        reason: `unknown action "${params.action}"`,
        fix: "supported actions: register, approve, post_job, bid, cancel_expired, withdraw_bid, cancel, accept, deliver, release, raise_ticket, resolve, settle, abandon, release_expired, reclaim_assignment, swap",
      };
  }

  const reservation = await reserveNonces(address, calls.length, await pendingNonce(address));
  const nonces = reservation.nonces;
  const steps: Step[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    steps.push(
      await buildStep({
        address,
        label: call.label,
        to: call.to,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        value: call.value,
        nonce: nonces[i],
      }),
    );
    // record the expected call so submit can verify what was actually signed
    const expected = await expectedCall(call.abi, call.functionName, call.args);
    steps[steps.length - 1].fn = expected.fn;
    steps[steps.length - 1].args = expected.args;
  }

  const intent = await createIntent({
    address,
    action: params.action,
    summary,
    cheque,
    steps,
    reservationId: reservation.id,
  });
  return { ok: true, intent, superseded: reservation.superseded };
}
