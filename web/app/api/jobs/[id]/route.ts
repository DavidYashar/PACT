import { NextResponse } from "next/server";
import { keccak256, toHex } from "viem";
import { getJobContent, getProof, listDisputes, listPitches } from "@/lib/content";
import { currentSession, isParty, readBids, readJob, readResolver } from "@/lib/server-chain";
import { termsDigest } from "@/lib/terms";

export const dynamic = "force-dynamic";

/// The content store is keyed by job id alone, and a redeployed escrow restarts its ids at 1.
/// Rather than trust a stored row, re-hash it and compare against what the chain holds: a row
/// that came from an earlier deployment can never match, so it is dropped instead of shown.
function verifyTerms<
  T extends { title: string; description: string; criteria: string; proofSpec: string; category: string },
>(content: T | null, termsHash?: string): T | null {
  if (!content || !termsHash) return null;
  return termsDigest(content).toLowerCase() === termsHash.toLowerCase() ? content : null;
}

function verifyProof<T extends { proof: string }>(proof: T | null, proofHash?: string): T | null {
  if (!proof || !proofHash) return null;
  return keccak256(toHex(proof.proof)).toLowerCase() === proofHash.toLowerCase() ? proof : null;
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "bad job id" }, { status: 400 });
  }

  try {
    const [stored, storedPitches, job, resolver, session, bids] = await Promise.all([
      getJobContent(jobId),
      listPitches(jobId),
      readJob(jobId),
      readResolver(),
      currentSession(),
      readBids(jobId),
    ]);

    /// Nothing from the store is trusted until it matches the chain.
    const content = verifyTerms(stored, job?.termsHash);
    const pitches = storedPitches.filter((p) => {
      const bid = bids[p.bidIndex];
      return bid && bid.worker.toLowerCase() === p.worker.toLowerCase();
    });

    /// Terms and pitches are marketplace data — anyone may read them to decide whether
    /// to bid. The deliverable and the complaint are private to the parties and the
    /// resolver, so they are only loaded when the session is entitled to them.
    const privileged = Boolean(
      session &&
        job &&
        (isParty(job, session.address) ||
          (resolver && resolver.toLowerCase() === session.address.toLowerCase())),
    );

    const [storedProof, disputes] = privileged
      ? await Promise.all([getProof(jobId), listDisputes()])
      : [null, []];
    const proof = verifyProof(storedProof, job?.proofHash);

    return NextResponse.json({
      content,
      pitches,
      proof,
      dispute: disputes.find((d) => d.jobId === jobId) ?? null,
      privileged,
      /// The address the withhold decision was made for. The page compares this to the
      /// connected wallet, so a stale cookie cannot show one wallet's deliverable under
      /// another wallet's name.
      session: session?.address ?? null,
      /// Public on-chain facts, returned so the page can tell a party to sign in
      /// rather than showing them a "this is private" dead end.
      parties: job
        ? { employer: job.employer, worker: job.worker, resolver: resolver ?? null }
        : null,
    });
  } catch (error) {
    console.error("job detail failed", error);
    return NextResponse.json({
      content: null,
      pitches: [],
      proof: null,
      dispute: null,
      privileged: false,
      session: null,
      parties: null,
    });
  }
}
