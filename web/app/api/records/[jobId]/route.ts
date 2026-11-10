import { NextResponse } from "next/server";
import { toHex } from "viem";
import { EXPLORER, NAMES_ADDRESS } from "@/lib/chain";
import { readRecorded } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// keccak256("JobRecorded(uint256,address,address,address)")
const JOB_RECORDED = "0xaaec4163e5fa5ad9bfb0ff799a5d11b7548b2711efbbd857ae13d4b8c9f06c2e";

/// Where a settled job's record lives, as a thing you can click.
///
/// The chain decides whether a record exists — `recorded(jobId)` on the registry — and the
/// explorer only supplies the transaction that wrote it. If the indexer is unavailable the
/// record is still real, so the answer says "inscribed" and simply omits the hash.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId: raw } = await params;
  const jobId = Number(raw);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }

  const inscribed = await readRecorded(jobId);
  if (!inscribed) {
    return NextResponse.json({ inscribed: false, txHash: null, contract: NAMES_ADDRESS });
  }

  let txHash: string | null = null;
  if (EXPLORER) {
    const topic = encodeURIComponent(toHex(BigInt(jobId), { size: 32 }));
    const url = `${EXPLORER}/api/v2/addresses/${NAMES_ADDRESS}/logs?topic=${JOB_RECORDED}&topic=${topic}`;

    try {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const body = (await res.json()) as { items?: { transaction_hash?: string }[] };
        txHash = body.items?.[0]?.transaction_hash ?? null;
      }
    } catch {
      // Indexer down or slow. The record is still on-chain; the link just falls back.
      txHash = null;
    }
  }

  return NextResponse.json({ inscribed: true, txHash, contract: NAMES_ADDRESS });
}
