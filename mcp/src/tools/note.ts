import { readBids } from "../chain.js";
import { savePitch } from "../content.js";

/// The note beside a bid.
///
/// It is deliberately not a transaction. The chain holds the price; this is the text an employer
/// reads before choosing between two equal bids, and it lives in the database where the app reads it.
/// No signature, for the same reason the price does not need one: it is public marketplace text, and
/// the only fact worth checking is that a bid really exists at the index it claims.
export async function note(input: { address: string; jobId: number; pitch: string; bidIndex?: number }) {
  const pitch = input.pitch.trim();
  if (!pitch) return { ok: false, reason: "the note is empty" };
  if (pitch.length > 2000) return { ok: false, reason: "a note can be at most 2000 characters" };

  const bids = await readBids(BigInt(input.jobId));
  if (bids.length === 0) {
    return {
      ok: false,
      reason: `job ${input.jobId} has no bids on chain`,
      fix: "place the bid first, or pass `pitch` to pact_plan with action bid so the two land together",
    };
  }

  const wanted = input.address.toLowerCase();
  if (typeof input.bidIndex === "number") {
    if (input.bidIndex < 0 || input.bidIndex >= bids.length) {
      return { ok: false, reason: `job ${input.jobId} has no bid at index ${input.bidIndex}` };
    }
    const bid = bids[input.bidIndex];
    if (bid.worker.toLowerCase() !== wanted) {
      return {
        ok: false,
        reason: `bid ${input.bidIndex} belongs to ${bid.worker}, not ${input.address}`,
        fix: "a note is stored against the wallet the chain names, never the one a request claims",
      };
    }
    if (bid.withdrawn) {
      return { ok: false, reason: "that bid was withdrawn", fix: "a withdrawn bid cannot carry a note; bid again first" };
    }
    await savePitch({ jobId: input.jobId, bidIndex: input.bidIndex, worker: bid.worker, pitch });
    return {
      ok: true,
      jobId: input.jobId,
      bidIndex: input.bidIndex,
      worker: bid.worker,
      pitch,
      note: "stored off chain and shown beside your bid; the price on chain is untouched",
    };
  }

  const index = bids.findIndex((b) => b.worker.toLowerCase() === wanted && !b.withdrawn);
  if (index < 0) {
    return {
      ok: false,
      reason: `this wallet has no live bid on job ${input.jobId}`,
      fix: "bid first, or check pact_get_job for the bids that exist",
    };
  }

  await savePitch({ jobId: input.jobId, bidIndex: index, worker: bids[index].worker, pitch });
  return {
    ok: true,
    jobId: input.jobId,
    bidIndex: index,
    worker: bids[index].worker,
    pitch,
    note: "stored off chain and shown beside your bid; the price on chain is untouched",
  };
}
