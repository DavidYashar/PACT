import { NextResponse } from "next/server";
import { listPitches, savePitch, type BidPitch } from "@/lib/content";
import { readBids } from "@/lib/server-chain";
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

/// A pitch is public marketplace text, like the bid it accompanies: anyone can already read the bid
/// list, so there is nothing here to protect and no reason to make the author sign for it. The write
/// is therefore unauthenticated, and that is a deliberate trade: the chain holds the price and the
/// worker who offered it, and this note is only ever displayed beside that bid. The one check that
/// matters is that a bid really exists at the index the note names — a note cannot create a bid, and
/// the address stored is the one the chain named, never the one the request claimed.
///
/// Private text — a deliverable, a complaint — is a different thing and does require a session,
/// because it must not leave the server for anyone but the parties and the resolver.
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

  const bids = await readBids(body.jobId);
  const bid = bids[body.bidIndex];
  if (!bid) return NextResponse.json({ error: "no bid at that index" }, { status: 409 });

  if (body.worker && body.worker.toLowerCase() !== bid.worker.toLowerCase()) {
    return NextResponse.json({ error: "that index belongs to a different wallet" }, { status: 403 });
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
