import { NextResponse } from "next/server";
import { keccak256, toHex } from "viem";
import { listDisputes, saveDispute, type DisputeRecord } from "@/lib/content";
import { currentSession, isParty, readJob } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ disputes: [] }, { status: 401 });

  /// Only the tickets this session is a party to, matched against the chain so the
  /// store cannot reveal a complaint to an unrelated wallet.
  const disputes = await listDisputes();
  const visible: DisputeRecord[] = [];

  for (const dispute of disputes) {
    const job = await readJob(dispute.jobId);
    if (job && isParty(job, session.address)) visible.push(dispute);
  }

  return NextResponse.json({ disputes: visible });
}

/// A complaint is the resolver's only decision input, so the write has to satisfy three things
/// before it is stored: the caller holds the key of the wallet that filed on chain, the text
/// re-hashes to the commitment that wallet made when it filed, and the row is written once.
///
/// `job.filer` alone proved nothing — it is a public field, so the old check was a comparison
/// between two copies of public data. Anyone could rewrite a live ticket and the resolver would
/// rule on the substitute.
export async function POST(request: Request) {
  let body: DisputeRecord;
  try {
    body = (await request.json()) as DisputeRecord;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Number.isInteger(body.jobId) || !body.reason) {
    return NextResponse.json({ error: "jobId and reason required" }, { status: 400 });
  }
  if (body.reason.length > 8_000) {
    return NextResponse.json({ error: "a complaint can be at most 8,000 characters" }, { status: 413 });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const job = await readJob(body.jobId);
  if (!job) return NextResponse.json({ error: "job not found on chain" }, { status: 404 });
  if (job.state !== 4) return NextResponse.json({ error: "job is not in dispute" }, { status: 409 });
  if (job.filer.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "only the wallet that filed the ticket may publish it" }, { status: 403 });
  }

  /// The chain holds the commitment. Deriving the digest from the text — never trusting the body —
  /// and comparing it to `reasonHash` on the job is what makes the stored complaint provably the
  /// one that was filed. Without this the filer could still replace their own story after filing,
  /// which is the same attack with one extra signature.
  const reasonHash = keccak256(toHex(body.reason));
  if (reasonHash.toLowerCase() !== job.reasonHash.toLowerCase()) {
    return NextResponse.json(
      { error: "this text does not match the reason committed on chain" },
      { status: 422 },
    );
  }

  /// Written once. An edit after the case file has been read is indistinguishable from a different
  /// complaint, and the resolver has no way to know which one the filer meant.
  const existing = await listDisputes();
  if (existing.some((d) => d.jobId === body.jobId && d.reasonHash.toLowerCase() === reasonHash.toLowerCase())) {
    return NextResponse.json({ ok: true, alreadyStored: true });
  }

  try {
    await saveDispute({
      jobId: body.jobId,
      filer: job.filer,
      reason: body.reason,
      reasonHash,
      filedAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("saveDispute failed", error);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
}
