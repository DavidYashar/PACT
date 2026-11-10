import { NextResponse } from "next/server";
import { listPitches, savePitch, type BidPitch } from "@/lib/content";
import { currentSession, readBids } from "@/lib/server-chain";
import { clientIp, rateLimit } from "@/lib/request-guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const jobId = Number(new URL(request.url).searchParams.get("jobId"));
  if (!Number.isInteger(jobId)) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  try {
    return NextResponse.json({ pitches: await listPitches(jobId) });
  } catch (error) {
    console.error("listPitches failed", error);
    return NextResponse.json({ pitches: [] });
  }
}

/// A pitch is the only off-chain write with no on-chain commitment behind it: the bid commits a
/// price, and the note beside it is free text. Everything else here is verified by re-deriving a
/// hash the contract already holds, which is impossible for free text — so authorship is the only
/// thing that can bind a pitch to a person, and authorship means a signed session.
///
/// Two checks, in order. The session says which wallet is writing. The chain says whether that
/// wallet actually holds a bid at the index the note claims, which also rejects an index invented
/// to land the note under someone else's name.
export async function POST(request: Request) {
  const limited = rateLimit(`pitches:${clientIp(request)}`, 30, 60_000);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }

  let body: BidPitch;
  try {
    body = (await request.json()) as BidPitch;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!Number.isInteger(body.jobId) || !Number.isInteger(body.bidIndex) || !body.pitch) {
    return NextResponse.json({ error: "jobId, bidIndex, pitch required" }, { status: 400 });
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  if (body.worker && body.worker.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "a pitch belongs to the wallet that wrote it" }, { status: 403 });
  }

  const bids = await readBids(body.jobId);
  const bid = bids[body.bidIndex];
  if (!bid || bid.worker.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json({ error: "no bid by this wallet at that index" }, { status: 409 });
  }

  try {
    /// Stored against the address the chain named, not the one the request claimed.
    await savePitch({ ...body, worker: bid.worker });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("savePitch failed", error);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
}
