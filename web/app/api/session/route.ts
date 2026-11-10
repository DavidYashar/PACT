import { NextResponse } from "next/server";
import { PayloadTooLarge, clientIp, rateLimit, readJsonWithLimit } from "@/lib/request-guard";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { verifyMessage } from "viem";
import { NONCE_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, buildMessage, signSession } from "@/lib/session-server";

export const dynamic = "force-dynamic";

const isAddressLike = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/// Step 1: hand back the exact message to sign. Any wallet may ask — what it can do
/// with the session is decided per endpoint, never here.
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!isAddressLike(address)) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  const nonce = randomUUID();
  const issuedAt = new Date().toISOString();
  const message = buildMessage(address, nonce, issuedAt);

  const store = await cookies();
  store.set(NONCE_COOKIE, `${nonce}|${issuedAt}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });

  return NextResponse.json({ message });
}

/// Step 2: verify the signature against the nonce this browser was given.
/// A session is free to start, so the only cost of abuse is the signature work and the nonce table.
/// Ten a minute per IP is far above what a person or an agent needs.
const MAX_BODY_BYTES = 8_000;

export async function POST(request: Request) {
  const limited = rateLimit(`session:${clientIp(request)}`, 10, 60_000);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "too many session attempts" },
      { status: 429, headers: { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) } },
    );
  }
  let body: { address?: string; signature?: string };
  try {
    body = (await request.json()) as { address?: string; signature?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { address, signature } = body;
  if (!isAddressLike(address) || typeof signature !== "string") {
    return NextResponse.json({ error: "address and signature required" }, { status: 400 });
  }

  const store = await cookies();
  const nonceCookie = store.get(NONCE_COOKIE)?.value;
  if (!nonceCookie) {
    return NextResponse.json({ error: "nonce expired, try again" }, { status: 400 });
  }

  const [nonce, issuedAt] = nonceCookie.split("|");
  if (!nonce || !issuedAt) {
    return NextResponse.json({ error: "malformed nonce" }, { status: 400 });
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: buildMessage(address, nonce, issuedAt),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json({ error: "signature did not verify" }, { status: 401 });
  }

  store.delete(NONCE_COOKIE);
  store.set(SESSION_COOKIE, signSession(address).token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return NextResponse.json({ ok: true, address: address.toLowerCase() });
}

/// Who am I, according to the cookie.
export async function HEAD() {
  const store = await cookies();
  const { readSession } = await import("@/lib/session-server");
  const session = readSession(store.get(SESSION_COOKIE)?.value);
  return new NextResponse(null, { status: session ? 200 : 401 });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(NONCE_COOKIE);
  return NextResponse.json({ ok: true });
}
