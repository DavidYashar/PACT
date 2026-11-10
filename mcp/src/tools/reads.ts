import { config, STATE_NAME, State, type Address } from "../config.js";
import {
  client,
  isRegistered,
  readAllowance,
  readBids,
  readClaimable,
  readDisputeResolution,
  readHistory,
  readJob,
  readJobCount,
  readProfile,
  readRecord,
  readResolver,
  readUnrecorded,
  readWifBalance,
  tryRead,
} from "../chain.js";
import { contentDigest, getDispute, getJobContent, getProof, getRulingNote, listPitches, proofDigest } from "../content.js";
import { readToken } from "../session.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/// WIF has 18 decimals, and amounts matter to the agent, so always give both.
export function amount(wei: bigint | null): { wei: string | null; wif: string } {
  if (wei === null) return { wei: null, wif: "unavailable" };
  const whole = Number(wei) / 1e18;
  return {
    wei: wei.toString(),
    wif: whole.toLocaleString("en-US", { maximumFractionDigits: 6 }),
  };
}

export async function whoami(address: Address) {
  const [registered, profile, balance, claimable, unrecorded, allowance] = await Promise.all([
    isRegistered(address),
    readProfile(address),
    tryRead(() => readWifBalance(address)),
    tryRead(() => readClaimable(address)),
    readUnrecorded(address),
    tryRead(() => readAllowance(address, config.escrow)),
  ]);

  return {
    address,
    chainId: config.chainId,
    registered,
    username: profile?.name && profile.name.length > 0 ? profile.name : null,
    kind: profile ? (profile.kind === 1 ? "AI" : "HUMAN") : null,
    wif: amount(balance),
    allowanceToEscrow: amount(allowance),
    claimable: amount(claimable),
    unrecorded: Number(unrecorded),
    /// The one sequencing rule an agent must not miss: claim is blocked until settled work
    /// has been written into the record.
    claimBlocked: unrecorded > 0n,
    next: registered
      ? ["list_jobs", "get_job", "plan"]
      : ["plan an action `register` to choose a username first"],
  };
}

export async function listJobs(params: {
  state?: string;
  minBudgetWif?: number;
  employer?: string;
  limit?: number;
  biddableOnly?: boolean;
  includeUnbiddable?: boolean;
}) {
  const total = await readJobCount();
  const limit = Math.min(params.limit ?? 20, 50);
  const wanted = params.state?.toUpperCase();

  const jobs: {
    jobId: number;
    state: string;
    employer: string;
    worker: string | null;
    budget: ReturnType<typeof amount>;
    price: ReturnType<typeof amount> | null;
    bidDeadline: string;
    deliveryDeadline: string;
    bondRequired: ReturnType<typeof amount> | null;
    bids: number;
    /// A job stays OPEN after its bidding window closes, and can never be accepted. Say so here
    /// so an agent does not spend a plan discovering it.
    biddable: boolean;
    autoReleaseSeconds: number;
  }[] = [];

  const latest = await client.getBlock({ blockTag: "latest" });

  /// The board defaults to jobs someone can act on. An open job past its bid window can never be
  /// assigned, and one agent measured its board as 88% corpses: a list an agent has to filter
  /// before it can trust it is a list that wastes calls. `includeUnbiddable` brings them back for
  /// whoever is looking for their own job rather than for work.
  const includeUnbiddable = params.includeUnbiddable ?? params.biddableOnly === false;
  let hidden = 0;

  // Newest first: the jobs an agent can act on are almost always the recent ones.
  for (let id = Number(total); id >= 1 && jobs.length < limit; id--) {
    const job = await readJob(BigInt(id));
    if (!job) continue;
    const stateName = STATE_NAME[job.state] ?? "UNKNOWN";
    if (wanted && stateName !== wanted) continue;
    if (params.minBudgetWif && Number(job.budget) / 1e18 < params.minBudgetWif) continue;
    if (params.employer && job.employer.toLowerCase() !== params.employer.toLowerCase()) continue;

    const biddable = job.state === State.OPEN && job.bidDeadline > latest.timestamp;
    if (!includeUnbiddable && job.state === State.OPEN && !biddable) {
      hidden += 1;
      continue;
    }

    const bids = await readBids(BigInt(id));
    const liveBids = bids.filter((b) => !b.withdrawn).length;
    jobs.push({
      jobId: id,
      state: stateName,
      employer: job.employer,
      worker: job.worker === ZERO ? null : job.worker,
      budget: amount(job.budget),
      price: job.price > 0n ? amount(job.price) : null,
      bidDeadline: new Date(Number(job.bidDeadline) * 1000).toISOString(),
      deliveryDeadline: new Date(Number(job.deliveryDeadline) * 1000).toISOString(),
      autoReleaseSeconds: Number(job.autoReleaseDelay),
      bondRequired: job.state === State.OPEN ? null : amount(job.bond),
      bids: liveBids,
      biddable,
    });
  }

  return {
    total: Number(total),
    returned: jobs.length,
    excludedExpiredOpenJobs: hidden,
    note: hidden > 0
      ? `${hidden} open job(s) are past their bid window and are hidden because nobody can win them. Pass includeUnbiddable: true to see them, or plan cancel_expired to return the money to their employers.`
      : undefined,
    jobs,
  };
}

export async function getJob(jobId: number) {
  const job = await readJob(BigInt(jobId));
  if (!job) return { found: false, jobId };

  const [bids, profile, content, pitches, latest, dispute] = await Promise.all([
    readBids(BigInt(jobId)),
    readProfile(job.employer),
    getJobContent(jobId),
    listPitches(jobId),
    client.getBlock({ blockTag: "latest" }),
    job.filer === ZERO ? Promise.resolve(null) : readDisputeResolution(BigInt(jobId)),
  ]);
  const chainNow = Number(latest.timestamp);
  /// The worker carries the same envelope as the employer. Returning a bare address here meant
  /// `job.worker.username` was silently empty on exactly the jobs that had a worker assigned —
  /// the ones that matter — and looked like a failed assignment rather than a missing field.
  const workerProfile = job.worker === ZERO ? null : await readProfile(job.worker);
  const bidProfiles = await Promise.all(bids.map((bid) => readProfile(bid.worker)));
  const stateName = STATE_NAME[job.state] ?? "UNKNOWN";
  const bond = job.price > 0n ? job.bond : job.budget / 2n;

  /// Terms are marketplace data, like the feed: anyone may read them, because nobody can price a
  /// job they cannot read. They are only served when the text reproduces the hash this job
  /// committed, so a stale row from an earlier deployment cannot pass as this job's brief.
  const termsMatch = Boolean(
    content && contentDigest(content).toLowerCase() === job.termsHash.toLowerCase(),
  );

  const next: string[] = [];
  if (job.state === State.OPEN) next.push("plan a `bid` with your price");
  if (job.state === State.ASSIGNED) next.push("deliver, then publish the proof");
  if (job.state === State.DELIVERED) next.push("wait for the employer, or a ticket");
  if (job.state === State.SETTLED) next.push("plan `settle` to record and claim");

  return {
    found: true,
    jobId,
    state: stateName,
    employer: { address: job.employer, username: profile?.name || null },
    worker:
      job.worker === ZERO ? null : { address: job.worker, username: workerProfile?.name || null },
    budget: amount(job.budget),
    price: job.price > 0n ? amount(job.price) : null,
    bondRequired: amount(bond),
    bidDeadline: new Date(Number(job.bidDeadline) * 1000).toISOString(),
    deliveryDeadline: new Date(Number(job.deliveryDeadline) * 1000).toISOString(),
    /// This job's own silence window, and the moment it starts paying out. A bidder prices the
    /// first; the second is what `release_expired` waits for.
    autoReleaseSeconds: Number(job.autoReleaseDelay),
    autoReleaseAt:
      Number(job.autoReleaseAt) > 0 ? new Date(Number(job.autoReleaseAt) * 1000).toISOString() : null,
    /// The decision, complete. The escrow stores who won and what each side was credited; the fine
    /// and the treasury cut exist only in the DisputeResolved event, so they are read back from it.
    /// A party that can see it lost but not why cannot learn anything, and an agent that cannot
    /// learn can only get more conservative.
    settlement:
      job.state === State.SETTLED
        ? {
            workerWon: job.workerWon,
            settledAt: Number(job.settledAt) > 0 ? new Date(Number(job.settledAt) * 1000).toISOString() : null,
            creditedToEmployer: amount(job.toEmployerPaid),
            creditedToWorker: amount(job.toWorkerPaid),
            filedBy:
              job.filer === ZERO
                ? null
                : job.filer.toLowerCase() === job.employer.toLowerCase()
                  ? "employer"
                  : "worker",
            /// Present only when the job went through a ticket, and itemised rather than summed:
            /// `fine` is what the loser forfeited from their own stake, `cut` is the platform's 5%
            /// of the price, and `filingFee` was paid by whoever opened the ticket at raise time —
            /// a different transaction, which is why one number cannot describe all three.
            ruling: dispute
              ? {
                  side: dispute.ruling,
                  fine: amount(dispute.fine),
                  cut: amount(dispute.cut),
                  filingFee: amount(dispute.filingFee),
                  treasuryTotal: amount(dispute.cut + dispute.filingFee),
                  blockNumber: Number(dispute.blockNumber),
                }
              : null,
            note: "all amounts are credits, before each party's own stake is subtracted. `ruling.fine` is the loser's penalty, `ruling.cut` the platform's share, `ruling.filingFee` what the filer paid to open the ticket.",
          }
        : null,
    terms: termsMatch && content
      ? {
          title: content.title,
          description: content.description,
          criteria: content.criteria,
          proofSpec: content.proofSpec,
          category: content.category,
          /// Only present when the employer committed to one. A bidder can check its own output
          /// against it before bidding, which is the difference between a job it can price and a
          /// job it has to guess at.
          expectedProofHash: content.expectedProofHash ?? null,
          /// True when a delivery can be approved with no judgment at all: the proof hash either
          /// equals the commitment or the job is not finished.
          selfVerifying: Boolean(content.expectedProofHash),
        }
      : null,
    /// False means the employer committed to terms on chain but never published the text, or the
    /// stored text no longer reproduces the commitment. Do not bid on a job whose terms are absent
    /// unless your owner accepts that risk.
    termsPublished: termsMatch,
    /// The deliverable is private to the parties. Only the commitment is public, and the
    /// text is destroyed once the job is recorded — this hash is what remains.
    proofHash: job.proofHash === `0x${"0".repeat(64)}` ? null : job.proofHash,
    proofRetired: job.state === State.SETTLED,
    termsHash: job.termsHash,
    hadTicket: job.filer !== ZERO,
    /// An OPEN job past its bidDeadline can never be assigned. The state does not say that; this
    /// does. Judged against the chain's own clock, not the caller's: an agent that converts a
    /// unix deadline with a local clock is wrong by its machine's UTC offset, and two of them have
    /// already read a live window as closed by exactly the offset of the laptop they ran on.
    biddable: job.state === State.OPEN && Number(job.bidDeadline) > chainNow,
    /// The reference clock for every deadline in this response, so no caller has to trust its own.
    chainNow: { unix: chainNow, iso: new Date(chainNow * 1000).toISOString() },
    bids: bids.map((b, index) => ({
      bidIndex: index,
      worker: { address: b.worker, username: bidProfiles[index]?.name || null },
      price: amount(b.price),
      accepted: b.accepted,
      /// A withdrawn bid still exists on the book, so it is listed and marked rather than hidden.
      /// An employer who cannot see why a bid is unusable will try to accept it.
      withdrawn: b.withdrawn,
      /// The pitch is why a bidder might be chosen over a cheaper one. Storing it and never
      /// returning it meant an employer could only ever decide on price.
      pitch: pitches.find((p) => p.bidIndex === index)?.pitch ?? null,
    })),
    next,
  };
}

export async function getProfile(address: Address) {
  const [profile, history, registered] = await Promise.all([
    readProfile(address),
    readHistory(address),
    isRegistered(address),
  ]);

  /// Category-level reputation, derived from settled jobs rather than asserted by anyone. The
  /// category is not on chain — it is published text, checked to reproduce the terms commitment —
  /// so this aggregates the jobs a profile already points at. Bounded, because a wallet with two
  /// thousand jobs should not turn a profile read into two thousand RPC calls; the cap is
  /// reported so the numbers are never mistaken for complete.
  const CATEGORY_SCAN_LIMIT = 60;
  const scanned = history.slice(-CATEGORY_SCAN_LIMIT);
  const byCategory = new Map<
    string,
    { category: string; asWorker: { done: number; earned: bigint; won: number; lost: number }; asEmployer: { posted: number; spent: bigint; won: number; lost: number } }
  >();

  const entries = await Promise.all(
    scanned.map(async (id) => {
      const [job, content] = await Promise.all([readJob(id), getJobContent(Number(id))]);
      return { id, job, category: content?.category ?? "unknown" };
    }),
  );

  for (const { job, category } of entries) {
    if (!job) continue;
    const bucket =
      byCategory.get(category) ??
      {
        category,
        asWorker: { done: 0, earned: 0n, won: 0, lost: 0 },
        asEmployer: { posted: 0, spent: 0n, won: 0, lost: 0 },
      };

    const isWorker = job.worker.toLowerCase() === address.toLowerCase();
    const isEmployer = job.employer.toLowerCase() === address.toLowerCase();
    const settled = job.state === State.SETTLED;

    if (isWorker) {
      if (settled) {
        bucket.asWorker.done += 1;
        bucket.asWorker.earned += job.toWorkerPaid;
        if (job.filer !== ZERO) {
          if (job.workerWon) bucket.asWorker.won += 1;
          else bucket.asWorker.lost += 1;
        }
      }
    }
    if (isEmployer) {
      bucket.asEmployer.posted += 1;
      if (settled) {
        bucket.asEmployer.spent += job.toEmployerPaid > 0n ? job.price - job.toEmployerPaid : job.price;
        if (job.filer !== ZERO) {
          if (job.workerWon) bucket.asEmployer.lost += 1;
          else bucket.asEmployer.won += 1;
        }
      }
    }
    byCategory.set(category, bucket);
  }

  return {
    address,
    registered,
    username: profile?.name && profile.name.length > 0 ? profile.name : null,
    kind: profile ? (profile.kind === 1 ? "AI" : "HUMAN") : null,
    /// Every counter below came from a settlement in the escrow, not from a claim or a vote.
    jobsPosted: profile?.jobsPosted ?? 0,
    jobsDone: profile?.jobsDone ?? 0,
    tickets: profile?.tickets ?? 0,
    earnedAsWorker: amount(profile?.earnedAsWorker ?? 0n),
    spentAsEmployer: amount(profile?.spentAsEmployer ?? 0n),
    /// The scoreboard's own inputs, already on chain, so a board is one read per account rather
    /// than a scan of every job. Gross WIF only: net is these minus the same side's stake, which the
    /// caller can do because both halves are here.
    scoreboard: profile
      ? {
          ticketsWon: profile.ticketsWon,
          ticketsLost: profile.ticketsLost,
          abandoned: profile.abandoned,
          receivedAsWorker: amount(profile.receivedAsWorker),
          bondedAsWorker: amount(profile.bondedAsWorker),
          stakedAsEmployer: amount(profile.stakedAsEmployer),
          receivedAsEmployer: amount(profile.receivedAsEmployer),
          feesPaid: amount(profile.feesPaid),
          /// The two columns a board actually sorts on. Kept explicit rather than left as arithmetic
          /// for the reader: a lost ticket costs a unit, and walking away costs a unit, so a worker
          /// who wins one and loses one sits below a worker who wins one.
          workerUnits: (profile.jobsDone ?? 0) - profile.ticketsLost - profile.abandoned,
          employerUnits: (profile.jobsPosted ?? 0) - profile.ticketsLost,
          netEarnedAsWorker: amount(profile.receivedAsWorker - profile.bondedAsWorker),
          netSpentAsEmployer: amount(profile.stakedAsEmployer + profile.feesPaid - profile.receivedAsEmployer),
        }
      : null,
    /// A record an employer can price. "12 writing jobs, no disputes" is the thing that lets a
    /// reliable agent charge more than an untested wallet; without it, price is the only signal.
    byCategory: [...byCategory.values()]
      .map((bucket) => ({
        category: bucket.category,
        asWorker: {
          settled: bucket.asWorker.done,
          earned: amount(bucket.asWorker.earned),
          disputesWon: bucket.asWorker.won,
          disputesLost: bucket.asWorker.lost,
        },
        asEmployer: {
          posted: bucket.asEmployer.posted,
          spent: amount(bucket.asEmployer.spent),
          disputesWon: bucket.asEmployer.won,
          disputesLost: bucket.asEmployer.lost,
        },
      }))
      .sort((a, b) => b.asWorker.settled - a.asWorker.settled),
    categoryCoverage: {
      scanned: scanned.length,
      recordedJobs: history.length,
      capped: history.length > CATEGORY_SCAN_LIMIT,
      note: `byCategory is derived from the most recent ${CATEGORY_SCAN_LIMIT} recorded jobs of this wallet. Jobs whose terms were never published show as "unknown".`,
    },
    recordedJobs: history.map((h) => Number(h)),
  };
}

export async function getRecord(jobId: number) {
  const record = await readRecord(BigInt(jobId));
  // The registry returns a zeroed struct for a job that was never inscribed, so an empty
  // record means "not found", not "found with nothing in it".
  if (!record || (record.jobId === 0n && record.recordedBy === ZERO)) {
    return { found: false, jobId, inscribed: false };
  }
  const inscribed = record.recordedBy !== ZERO;
  return {
    found: true,
    jobId,
    inscribed,
    employer: record.employer,
    worker: record.worker,
    termsHash: record.termsHash,
    proofHash: record.proofHash,
    hadTicket: record.hadTicket,
    workerWon: record.workerWon,
    paidToWorker: amount(record.paidToWorker),
    spentByEmployer: amount(record.spentByEmployer),
    settledAt: Number(record.settledAt) > 0 ? new Date(Number(record.settledAt) * 1000).toISOString() : null,
    recordedBy: inscribed ? record.recordedBy : null,
  };
}

/// The case file for one job: the public terms, and — for the employer, the worker and the
/// resolver only — the deliverable and the complaint.
///
/// Gating happens here, on the server, against the chain. A wallet address is public, so a token
/// that merely proves an address would not be enough; the address must also be the employer, the
/// worker, or the resolver of *this* job. A stranger holding a valid session gets a refusal, not
/// a redacted file, because a redacted file still leaks whether a complaint exists.
export async function getCase(jobId: number, token: string | undefined) {
  const session = readToken(token);
  if (!session) {
    return {
      found: false as const,
      jobId,
      allowed: false as const,
      reason: "no valid session for this call",
      fix: "pact_session_start, sign the message with personal_sign, then pact_session_finish and pass the token",
    };
  }
  const job = await readJob(BigInt(jobId));
  if (!job) return { found: false as const, jobId, allowed: false as const, reason: `job ${jobId} does not exist` };

  const address = session.address.toLowerCase();
  const isEmployer = job.employer.toLowerCase() === address;
  const isWorker = job.worker.toLowerCase() === address;
  const isResolver = await readResolver().then(
    (resolver) => resolver !== null && resolver.toLowerCase() === address,
    () => false,
  );
  const isParty = isEmployer || isWorker;

  if (!isParty && !isResolver) {
    return {
      found: true as const,
      jobId,
      state: STATE_NAME[job.state] ?? "UNKNOWN",
      allowed: false as const,
      reason: "this wallet is not the employer, the worker, or the resolver of this job",
      visible: [] as string[],
    };
  }

  const [terms, proof, complaint, note, jobRecord] = await Promise.all([
    getJobContent(jobId),
    getProof(jobId),
    getDispute(jobId),
    getRulingNote(jobId),
    readRecord(BigInt(jobId)),
  ]);

  /// Re-hash the text, don't trust the row. A row that carries a matching `terms_hash` while its
  /// words say something else belongs to a different job that used the same id under an earlier
  /// deployment, and serving it would hand one employer another employer's brief.
  const termsMatch = Boolean(
    terms && contentDigest(terms).toLowerCase() === job.termsHash.toLowerCase(),
  );
  const proofMatch = Boolean(
    proof &&
      proof.proofHash.toLowerCase() === job.proofHash.toLowerCase() &&
      proofDigest(proof.proof).toLowerCase() === job.proofHash.toLowerCase(),
  );

  const visible = ["terms", "history"];
  if (isParty || isResolver) visible.push("deliverable");
  if (isResolver || isParty) visible.push("complaint");

  /// Once a job is inscribed the text is gone on purpose; the record is what remains.
  const inscribed = jobRecord !== null && jobRecord.recordedBy !== ZERO;

  return {
    found: true as const,
    jobId,
    state: STATE_NAME[job.state] ?? "UNKNOWN",
    allowed: true as const,
    as: { employer: isEmployer, worker: isWorker, resolver: isResolver },
    visible,
    terms: termsMatch && terms
      ? {
          title: terms.title,
          description: terms.description,
          criteria: terms.criteria,
          proofSpec: terms.proofSpec,
          category: terms.category,
          expectedProofHash: terms.expectedProofHash ?? null,
          termsHash: terms.termsHash,
        }
      : null,
    /// The deliverable, with the hash it must reproduce. A resolver reads this and compares it
    /// against the criteria — the chain can prove it landed in time, not that it is any good.
    deliverable: proofMatch && proof
      ? {
          proof: proof.proof,
          proofHash: proof.proofHash,
          worker: proof.worker,
          submittedAt: proof.createdAt,
        }
      : null,
    complaint: complaint
      ? { reason: complaint.reason, reasonHash: complaint.reasonHash, filer: complaint.filer, filedAt: complaint.filedAt }
      : null,
    ruling: note,
    inscribed,
    /// Text that a job committed to but never published reads as missing, not as empty. This
    /// only happens when a write is attempted before its transaction confirms.
    missing: [
      ...(termsMatch ? [] : ["terms"]),
      ...(proof && !proofMatch ? ["deliverable (stored text no longer matches proofHash)"] : []),
    ],
    /// What a decision-maker needs, stated flatly: what is locked, and what releasing it does.
    money: {
      price: amount(job.price > 0n ? job.price : job.budget),
      employerEscrow: amount(job.employerEscrow),
      workerEscrow: amount(job.workerEscrow),
      autoReleaseAt: Number(job.autoReleaseAt) > 0 ? new Date(Number(job.autoReleaseAt) * 1000).toISOString() : null,
      deliveryDeadline: new Date(Number(job.deliveryDeadline) * 1000).toISOString(),
    },
    next:
      isResolver && job.state === State.DISPUTED
        ? ["decide with `resolve`"]
        : isParty
          ? ["approve, file a ticket, or wait"]
          : [],
  };
}