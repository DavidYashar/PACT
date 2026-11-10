import { NextResponse } from "next/server";
import { getRuling, saveRuling } from "@/lib/content";
import { currentSession, readJob, readResolver } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// The reasoning behind a ruling. Not part of the settlement — the contract already
/// moved the money — but a party is entitled to know why.
export async function GET(request: Request) {
  const jobId = Number(new URL(request.url).searchParams.get("jobId"));
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ ruling: null }, { status: 401 });

  const [job, resolver] = await Promise.all([readJob(jobId), readResolver()]);
  if (!job) return NextResponse.json({ ruling: null }, { status: 404 });

  const me = session.address.toLowerCase();
  const entitled =
    job.employer.toLowerCase() === me ||
    job.worker.toLowerCase() === me ||
    Boolean(resolver && resolver.toLowerCase() === me);

  if (!entitled) return NextResponse.json({ ruling: null }, { status: 403 });

  return NextResponse.json({ ruling: await getRuling(jobId) });
}

export async function POST(request: Request) {
  let body: { jobId?: number; ruling?: string; note?: string };
  try {
    body = (await request.json()) as { jobId?: number; ruling?: string; note?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const jobId = Number(body.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  if (body.ruling !== "worker" && body.ruling !== "employer") {
    return NextResponse.json({ error: "ruling must be worker or employer" }, { status: 400 });
  }

  const note = (body.note ?? "").trim();
  if (note.length < 10) {
    return NextResponse.json({ error: "write at least a sentence" }, { status: 400 });
  }
  if (note.length > 2000) {
    return NextResponse.json({ error: "keep the note under 2000 characters" }, { status: 400 });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  /// Only the wallet the contract currently recognises as resolver may write this, and
  /// only once the job is actually settled. A party can never author its own outcome.
  const [job, resolver] = await Promise.all([readJob(jobId), readResolver()]);
  if (!job) return NextResponse.json({ error: "job not found on chain" }, { status: 404 });
  if (!resolver || resolver.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "not the resolver" }, { status: 403 });
  }
  if (job.state !== 5) {
    return NextResponse.json({ error: "this job is not settled yet" }, { status: 409 });
  }

  try {
    await saveRuling({
      jobId,
      resolver: session.address.toLowerCase(),
      ruling: body.ruling,
      note,
      recordedAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("saveRuling failed", error);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
}
