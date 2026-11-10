import { NextResponse } from "next/server";
import { currentSession, isParty, ticketDetail } from "@/lib/server-chain";
import { listDisputes, getRuling } from "@/lib/content";

export const dynamic = "force-dynamic";

/// One ticket, in full. 403 unless the session is the resolver or a party to it —
/// the complaint and the deliverable never leave the server for anyone else.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "bad ticket id" }, { status: 400 });
  }

  const detail = await ticketDetail(jobId);
  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isResolver = Boolean(
    detail.resolver && detail.resolver.toLowerCase() === session.address.toLowerCase(),
  );
  const party = isParty(detail.job, session.address);

  if (!isResolver && !party) {
    return NextResponse.json({ error: "not your ticket" }, { status: 403 });
  }

  const disputes = await listDisputes();
  const dispute = disputes.find((d) => d.jobId === jobId) ?? null;
  const ruling = await getRuling(jobId);

  /// Does the stored complaint reproduce the hash the filer committed to on chain? The proof beside
  /// it is badged, and a reader will assume the same of the criteria and the complaint unless told
  /// otherwise — so the difference has to be visible, not implied.
  const disputeVerified = Boolean(
    dispute &&
      detail.job.reasonHash &&
      dispute.reasonHash.toLowerCase() === detail.job.reasonHash.toLowerCase(),
  );
  const proofVerified = Boolean(
    detail.proof && detail.proof.proofHash.toLowerCase() === detail.job.proofHash.toLowerCase(),
  );

  const role = isResolver
    ? "resolver"
    : detail.job.employer.toLowerCase() === session.address.toLowerCase()
      ? "employer"
      : "worker";

  return NextResponse.json({
    session: session.address,
    isResolver,
    role,
    jobId,
    job: {
      employer: detail.job.employer,
      worker: detail.job.worker,
      filer: detail.job.filer,
      state: detail.job.state,
      budget: detail.job.budget.toString(),
      price: detail.job.price.toString(),
      bond: detail.job.bond.toString(),
      employerEscrow: detail.job.employerEscrow.toString(),
      workerEscrow: detail.job.workerEscrow.toString(),
      proofHash: detail.job.proofHash,
      termsHash: detail.job.termsHash,
      reasonHash: detail.job.reasonHash,
      timedOut: detail.job.timedOut,
    },
    resolver: detail.resolver,
    content: detail.content,
    proof: detail.proof,
    dispute,
    disputeVerified,
    proofVerified,
    ruling,
  });
}
