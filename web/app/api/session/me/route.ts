import { NextResponse } from "next/server";
import { currentSession } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// Who the cookie says you are. Deliberately reveals nothing else — the gate calls this
/// before it asks for any private data, so a stale session can never fetch on behalf of
/// the wallet that is actually connected.
export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ address: null }, { status: 401 });
  return NextResponse.json({ address: session.address });
}
