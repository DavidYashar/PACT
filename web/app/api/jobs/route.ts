import { NextResponse } from "next/server";
import { listJobContent, saveJobContent, type JobContent } from "@/lib/content";
import { readJob } from "@/lib/server-chain";
import { termsDigest } from "@/lib/terms";

export const dynamic = "force-dynamic";

/// Published terms, newest first, paginated. Marketplace data: safe to read without a session. The
/// page size is capped because an unbounded list is a way to make this endpoint expensive, and no
/// caller needs more than a screen at a time.
const PAGE_SIZE = 50;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get("limit") ?? PAGE_SIZE) || PAGE_SIZE, 1), PAGE_SIZE);
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);

  try {
    const all = await listJobContent();
    return NextResponse.json({
      total: all.length,
      limit,
      offset,
      jobs: all.slice(offset, offset + limit),
    });
  } catch (error) {
    console.error("listJobContent failed", error);
    return NextResponse.json({ total: 0, limit, offset, jobs: [] }, { status: 200 });
  }
}

export async function POST(request: Request) {
  let body: JobContent;
  try {
    body = (await request.json()) as JobContent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Number.isInteger(body.jobId) || body.jobId <= 0) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  if (!body.termsHash || !body.employer) {
    return NextResponse.json({ error: "termsHash and employer required" }, { status: 400 });
  }

  /// The stored text must hash to what the employer actually committed on-chain.
  /// Without this, anyone could publish different terms against someone else's job.
  const digest = termsDigest({
    title: body.title,
    description: body.description,
    criteria: body.criteria,
    proofSpec: body.proofSpec,
    category: body.category,
    ...(body.expectedProofHash ? { expectedProofHash: body.expectedProofHash } : {}),
  });

  if (digest.toLowerCase() !== body.termsHash.toLowerCase()) {
    return NextResponse.json({ error: "terms do not match the on-chain hash" }, { status: 422 });
  }

  const job = await readJob(body.jobId);
  if (!job) return NextResponse.json({ error: "job not found on chain" }, { status: 404 });
  if (job.termsHash.toLowerCase() !== digest.toLowerCase()) {
    return NextResponse.json({ error: "terms hash mismatch" }, { status: 422 });
  }
  if (job.employer.toLowerCase() !== body.employer.toLowerCase()) {
    return NextResponse.json({ error: "employer does not own this job" }, { status: 403 });
  }

  try {
    await saveJobContent(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("saveJobContent failed", error);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
}
