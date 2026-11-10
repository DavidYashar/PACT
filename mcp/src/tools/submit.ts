import { formatEther, parseEventLogs } from "viem";
import { config, STATE_NAME } from "../config.js";
import { client, pendingNonce, readBids, readJob } from "../chain.js";
import { claimIntent, getIntent, releaseReservation } from "../intents.js";
import { verifySignedStep } from "../validate.js";
import { ERC20_ABI, poolFor } from "../swap.js";
import {
  saveDispute,
  saveJobContent,
  savePitch,
  saveProof,
  saveRulingNote,
  termsDigest,
  type Terms,
} from "../content.js";

export type SubmitResult =
  | {
      ok: true;
      intentId: string;
      action: string;
      receipts: { step: string; hash: string; blockNumber: string; status: string }[];
      jobId: number | null;
      jobState: string | null;
      published: string[];
      next: string[];
    }
  | { ok: false; reason: string; fix?: string; failedAt?: number };

/// Take signed transactions, check every one of them against the intent that was prepared,
/// broadcast them in order, and wait for the receipts before answering.
///
/// The server has no key. It cannot sign, and it cannot substitute a different call: if the
/// bytes do not match the plan exactly, nothing is sent.
export async function submit(params: { intentId: string; signed: string[] }): Promise<SubmitResult> {
  const intent = await getIntent(params.intentId);
  if (!intent) return { ok: false, reason: `intent ${params.intentId} does not exist` };
  if (intent.status !== "pending") {
    const why =
      intent.status === "superseded"
        ? "a newer plan replaced this one, because only one plan can be live per wallet"
        : `intent is already ${intent.status}`;
    return { ok: false, reason: why, fix: "prepare a new intent" };
  }
  if (intent.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "this intent expired before it was submitted", fix: "prepare a new intent" };
  }
  if (params.signed.length !== intent.steps.length) {
    return {
      ok: false,
      reason: `expected ${intent.steps.length} signed transaction(s), received ${params.signed.length}`,
    };
  }

  // Check them all before sending any, so a bad second signature cannot leave the first landed.
  for (let i = 0; i < params.signed.length; i++) {
    const failure = await verifySignedStep({
      signed: params.signed[i] as `0x${string}`,
      step: intent.steps[i],
      expectedFrom: intent.address,
    });
    if (failure) return { ok: false, reason: failure.reason, fix: "sign exactly the prepared transaction", failedAt: i };
  }

  /// The prepared nonces have to be the ones the chain is waiting for. If a plan is signed above a
  /// hole, the transaction is valid but it queues behind a nonce that will never arrive, and the
  /// only thing the agent sees is a receipt that times out. Say which nonce and why instead.
  const chainNonce = await pendingNonce(intent.address);
  const firstNonce = BigInt(intent.steps[0].nonce);
  if (firstNonce > chainNonce) {
    return {
      ok: false,
      reason:
        `this plan was issued nonce ${firstNonce}, but the chain is waiting for nonce ${chainNonce}. ` +
        `A signature sent now would queue behind a hole and never be mined.`,
      fix: "an earlier plan from this wallet was never submitted; prepare a new intent, which will reuse those nonces",
    };
  }
  if (firstNonce < chainNonce) {
    return {
      ok: false,
      reason: `this plan was issued nonce ${firstNonce}, but the chain has already moved on to ${chainNonce}`,
      fix: "the plan is stale; prepare a new intent",
    };
  }

  // One submission per intent, decided in the database so two racing callers cannot both win.
  if (!(await claimIntent(intent.id))) {
    return { ok: false, reason: "this intent was already submitted", fix: "prepare a new intent" };
  }

  /// The nonces are spent, so the reservation no longer holds the floor. Releasing it here keeps
  /// the next plan as low as the chain allows.
  if (intent.reservationId) await releaseReservation(intent.reservationId);

  const receipts: { step: string; hash: string; blockNumber: string; status: string }[] = [];
  /// The job a `postJob` created belongs to the receipt that created it. Reading `jobCount` after
  /// the receipt is a race: a `postJob` mined in between moves the counter onto someone else's job,
  /// and this server then publishes the employer's private brief onto a job they do not own.
  let postedJobId: bigint | null = null;
  for (let i = 0; i < params.signed.length; i++) {
    const signed = params.signed[i] as `0x${string}`;
    try {
      const hash = await client.sendRawTransaction({ serializedTransaction: signed });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (intent.steps[i].fn === "postJob") {
        const { escrowAbi } = await import("../abi.js");
        const [posted] = parseEventLogs({ abi: escrowAbi, eventName: "JobPosted", logs: receipt.logs });
        if (posted) postedJobId = (posted.args as { jobId: bigint }).jobId;
      }
      receipts.push({
        step: intent.steps[i].label,
        hash,
        blockNumber: receipt.blockNumber.toString(),
        status: receipt.status,
      });
      if (receipt.status !== "success") {
        return {
          ok: false,
          reason: `step ${i} (${intent.steps[i].label}) reverted on chain`,
          fix: "read the job state; a precondition probably changed",
          failedAt: i,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `step ${i} (${intent.steps[i].label}) could not be sent: ${(error as Error).message}`,
        failedAt: i,
      };
    }
  }

  // Report the resulting state so the agent never has to guess what happened.
  let jobId: number | null = null;
  let jobState: string | null = null;
  const next: string[] = [];
  const published: string[] = [];

  if (intent.action === "post_job") {
    /// The id comes from the receipt's own `JobPosted` log, never from a counter read afterwards.
    if (postedJobId === null) {
      return {
        ok: false,
        reason: "the postJob transaction confirmed but its receipt carried no JobPosted log",
        fix: "do not publish text without the id the chain emitted; read the job back from the receipt",
      };
    }
    jobId = Number(postedJobId);
    jobState = "OPEN";

    /// The text is published only now, after the receipt, because before that there is no job to
    /// attach it to. Publishing cannot lie: the row is only accepted if its digest reproduces the
    /// on-chain commitment.
    const terms = intent.cheque.terms as Terms | undefined;
    if (terms) {
      const termsHash = termsDigest(terms);
      if (termsHash.toLowerCase() !== String(intent.cheque.termsHash).toLowerCase()) {
        return {
          ok: false,
          reason: "the job is posted, but the terms no longer hash to what was committed",
          fix: `read job ${jobId} and publish terms with this digest: ${termsHash}`,
        };
      }
      await saveJobContent({
        jobId,
        ...terms,
        employer: intent.address,
        termsHash,
        createdAt: new Date().toISOString(),
      });
      published.push("terms");
    }

    next.push("wait for a bid", "accept a bid with `accept`");
  } else if (intent.action === "bid") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const job = jobId ? await readJob(BigInt(jobId)) : null;
    jobState = job ? String(STATE_NAME[job.state]) : null;

    const pitch = intent.cheque.pitch as string | undefined;
    if (pitch && jobId) {
      const bids = await readBids(BigInt(jobId));
      const index = bids.findIndex((b) => b.worker.toLowerCase() === intent.address.toLowerCase());
      if (index >= 0) {
        await savePitch({ jobId, bidIndex: index, worker: intent.address, pitch });
        published.push("pitch");
      }
    }

    next.push("wait for the employer to accept");
  } else if (intent.action === "deliver") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const proof = intent.cheque.proof as string | undefined;
    const proofHash = intent.cheque.proofHash as string | undefined;
    if (proof && proofHash && jobId) {
      /// Stored only now, after the receipt: the text cannot exist for a commitment that has not
      /// landed. The hash check means a stored deliverable always reproduces what the chain holds.
      await saveProof({ jobId, worker: intent.address, proof, proofHash });
      published.push("deliverable");
    }
    const job = jobId ? await readJob(BigInt(jobId)) : null;
    jobState = job ? String(STATE_NAME[job.state]) : null;
    /// The window is the job's own, chosen at posting time; it is not the deployment default and
    /// it is not always 14 days.
    const windowSeconds = Number(job?.autoReleaseDelay ?? 0n);
    const windowText =
      windowSeconds > 0
        ? windowSeconds % 86_400 === 0
          ? `${windowSeconds / 86_400}-day`
          : `${Math.round(windowSeconds / 60)}-minute`
        : "auto-release";
    next.push(`the employer approves, files a ticket, or the ${windowText} clock releases it`);
  } else if (intent.action === "raise_ticket") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const reason = intent.cheque.reason as string | undefined;
    const reasonHash = intent.cheque.reasonHash as string | undefined;
    if (reason && reasonHash && jobId) {
      await saveDispute({ jobId, filer: intent.address, reason, reasonHash });
      published.push("complaint");
    }
    jobState = "DISPUTED";
    next.push("the resolver decides; both stakes stay frozen until then");
  } else if (intent.action === "resolve") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const note = intent.cheque.note as string | undefined;
    if (jobId) {
      await saveRulingNote({
        jobId,
        resolver: intent.address,
        ruling: String(intent.cheque.ruling ?? ""),
        note: note && note.length > 0 ? note : "(no reasoning published)",
      });
      published.push("ruling note");
    }
    const job = jobId ? await readJob(BigInt(jobId)) : null;
    jobState = job ? String(STATE_NAME[job.state]) : null;
    next.push("both parties settle to record and claim");
  } else if (intent.action === "accept") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const job = jobId ? await readJob(BigInt(jobId)) : null;
    jobState = job ? String(STATE_NAME[job.state]) : null;
    next.push("the worker delivers with proof before the deadline");
  } else if (intent.action === "release" || intent.action === "release_expired" || intent.action === "abandon") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const job = jobId ? await readJob(BigInt(jobId)) : null;
    jobState = job ? String(STATE_NAME[job.state]) : null;
    next.push("settle to record the job and claim any balance");
  } else if (intent.action === "settle") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    const job = jobId ? await readJob(BigInt(jobId)) : null;
    jobState = job ? String(STATE_NAME[job.state]) : null;
    const remaining = await client.readContract({
      address: config.escrow,
      abi: (await import("../abi.js")).escrowAbi,
      functionName: "claimable",
      args: [intent.address],
    });
    /// Only say the money moved if a claim step was actually part of this intent. A record-only
    /// settle used to report "the balance is claimed" having claimed nothing.
    if (intent.cheque.claims) {
      next.push(remaining > 0n ? "a balance remains; run settle again" : "the balance is claimed");
    } else {
      next.push(remaining > 0n ? "a balance is claimable; run settle again to withdraw it" : "nothing was claimable");
    }
  } else if (intent.action === "register") {
    next.push("post a job", "bid on a job");
  } else if (intent.action === "cancel") {
    jobId = Number(intent.cheque.jobId ?? 0) || null;
    jobState = "CANCELLED";
    const claimable = await client.readContract({
      address: config.escrow,
      abi: (await import("../abi.js")).escrowAbi,
      functionName: "claimable",
      args: [intent.address],
    });
    next.push(`you now have ${Number(claimable) / 1e18} WIF claimable, taken with \`claim\``);
  } else if (intent.action === "approve") {
    next.push("retry the action that needed the allowance");
  } else if (intent.action === "swap") {
    /// Report balances rather than restating the quote: the receipt is the proof the trade landed,
    /// and the balances are what an agent needs before choosing the next size.
    try {
      const pool = poolFor(config.chainId);
      const [wif, eth] = await Promise.all([
        client.readContract({
          address: pool.token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [intent.address],
        }),
        client.getBalance({ address: intent.address }),
      ]);
      next.push(
        `you now hold ${Number(formatEther(wif)).toLocaleString("en-US", { maximumFractionDigits: 2 })} WIF and ${formatEther(eth)} ETH`,
      );
    } catch {
      next.push("the swap confirmed");
    }
  }

  return { ok: true, intentId: intent.id, action: intent.action, receipts, jobId, jobState, published, next };
}
