import { NextResponse } from "next/server";
import { retireJob } from "@/lib/content";
import { currentSession, isParty, readJob, readRecorded } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// Destroy the off-chain text for a job once it is inscribed on-chain.
///
/// This is the hinge of the whole design: while a job is live the terms, pitches and proof
/// text live in Postgres so the parties can read them; once the work is settled AND recorded,
/// the contract holds the two hashes and the settlement facts forever, and the text is
/// deliberately thrown away. Nothing here is recoverable afterwards — that is the point.
export async function POST(request: Request) {
  let body: { jobId?: number };
  try {
    body = (await request.json()) as { jobId?: number };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const jobId = Number(body.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const job = await readJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found on chain" }, { status: 404 });
  if (!isParty(job, session.address)) {
    return NextResponse.json({ error: "not a party to this job" }, { status: 403 });
  }
  if (job.state !== 5) {
    return NextResponse.json({ error: "this job is not settled" }, { status: 409 });
  }

  /// Refuse unless the chain already holds the record. Deleting first would destroy the only
  /// copy of the text with nothing to replace it.
  if (!(await readRecorded(jobId))) {
    return NextResponse.json({ error: "record this job on-chain first" }, { status: 409 });
  }

  try {
    await retireJob(jobId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("retireJob failed", error);
    return NextResponse.json({ error: "could not retire" }, { status: 500 });
  }
}
