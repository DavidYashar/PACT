import { NextResponse } from "next/server";
import { keccak256, toHex } from "viem";
import { getProof, saveProof, type JobProof } from "@/lib/content";
import { currentSession, readJob, readResolver } from "@/lib/server-chain";
import { PayloadTooLarge, clientIp, rateLimit, readJsonWithLimit } from "@/lib/request-guard";

export const dynamic = "force-dynamic";

/// 20,000 characters of deliverable plus JSON overhead.
const MAX_PROOF_BYTES = 24_000;

/// The deliverable is private: parties and the resolver only.
export async function GET(request: Request) {
  const jobId = Number(new URL(request.url).searchParams.get("jobId"));
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ proof: null }, { status: 401 });

  const [job, resolver] = await Promise.all([readJob(jobId), readResolver()]);
  if (!job) return NextResponse.json({ proof: null }, { status: 404 });

  const party =
    job.employer.toLowerCase() === session.address.toLowerCase() ||
    job.worker.toLowerCase() === session.address.toLowerCase();
  const isResolver = Boolean(resolver && resolver.toLowerCase() === session.address.toLowerCase());

  if (!party && !isResolver) {
    return NextResponse.json({ proof: null }, { status: 403 });
  }

  return NextResponse.json({ proof: await getProof(jobId) });
}

export async function POST(request: Request) {
  const limited = rateLimit(`proofs:${clientIp(request)}`, 30, 60_000);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }

  /// A deliverable is at most 20,000 characters, which the database enforces. The cap here is that
  /// plus JSON overhead, so an oversized body is refused as 413 before it is buffered or stored.
  const parsed = await readJsonWithLimit<JobProof>(request, MAX_PROOF_BYTES);
  if (parsed instanceof PayloadTooLarge) {
    return NextResponse.json({ error: `deliverable exceeds ${MAX_PROOF_BYTES} bytes` }, { status: 413 });
  }
  if (!parsed) return NextResponse.json({ error: "invalid json" }, { status: 400 });
  const body: JobProof = parsed;

  if (!Number.isInteger(body.jobId) || !body.worker || !body.proof || !body.proofHash) {
    return NextResponse.json({ error: "jobId, worker, proof, proofHash required" }, { status: 400 });
  }

  /// The artifact must hash to the value the worker committed, and come from the worker
  /// that job actually has. Otherwise anyone could plant a fake deliverable.
  const job = await readJob(body.jobId);
  if (!job) return NextResponse.json({ error: "job not found on chain" }, { status: 404 });

  if (job.worker.toLowerCase() !== body.worker.toLowerCase()) {
    return NextResponse.json({ error: "worker does not match this job" }, { status: 403 });
  }

  if (job.proofHash.toLowerCase() !== body.proofHash.toLowerCase()) {
    return NextResponse.json({ error: "proof does not match the on-chain hash" }, { status: 422 });
  }

  /// Re-hash the text itself. Matching the claimed hash is not enough — otherwise the
  /// stored deliverable could be anything while quoting the worker's commitment.
  if (keccak256(toHex(body.proof)).toLowerCase() !== body.proofHash.toLowerCase()) {
    return NextResponse.json({ error: "proof text does not hash to the committed value" }, { status: 422 });
  }

  try {
    await saveProof(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("saveProof failed", error);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
}
