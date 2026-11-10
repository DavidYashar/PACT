/// Sessions for agents.
///
/// The problem this solves: a wallet address is public, so knowing one must never be enough to
/// read a private deliverable or a complaint. An agent therefore proves it holds the key by
/// signing a message, once per session, and receives a token it passes to the tools that need it.
///
/// Two deliberate choices:
///
/// 1. The message is byte-identical to the one the website asks a human to sign. An agent reading
///    SKILL.md and a person clicking "sign in" are doing the same thing, and the wording says out
///    loud that the signature authorises no transfer.
/// 2. The token uses the same HMAC format and secret as the website's `pact_session` cookie, so a
///    token minted here is accepted there. Authorisation stays in one place — the route handlers —
///    instead of being reimplemented per surface.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { client } from "./chain.js";
import { db } from "./db.js";
import type { Address } from "./config.js";
/// Shared with the web app. Rotating it invalidates every agent session and every browser cookie.
///
/// Fail closed. A built-in default is a published secret: the value this file used to carry is in
/// every clone's history, so anyone could mint a session token for any address and read that
/// wallet's case file. Without a configured secret this server refuses to start, because a server
/// that issues forgeable tokens is worse than one that is down.
const PUBLISHED_SECRET = "pact-dev-session-secret-change-me-in-production";

function resolveSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (!configured || configured === PUBLISHED_SECRET) {
    throw new Error(
      configured
        ? "SESSION_SECRET is the published development value — rotate it before starting"
        : "SESSION_SECRET is required: sessions are signed with it, and it must match the web app",
    );
  }
  if (Buffer.byteLength(configured, "utf8") < 32) {
    throw new Error("SESSION_SECRET must be at least 32 bytes — generate one with `openssl rand -hex 32`");
  }
  return configured;
}

const SECRET = resolveSecret();

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const NONCE_TTL_MS = 5 * 60 * 1000;

/// The exact string that gets signed. Built here so a client cannot substitute a different one,
/// and rebuilt verbatim when the signature comes back.
export function buildMessage(address: string, nonce: string, issuedAt: string): string {
  return [
    "PACT session",
    "",
    `address: ${address.toLowerCase()}`,
    `nonce: ${nonce}`,
    `issued: ${issuedAt}`,
    "",
    "Signing proves you hold this key. It costs no gas and authorises no transfer.",
  ].join("\n");
}

let ready = false;

async function ensureSchema(): Promise<void> {
  if (ready) return;
  const sql = db();
  await sql`
    create table if not exists mcp_session_nonce (
      id         text primary key,
      address    text not null,
      nonce      text not null,
      issued_at  timestamptz not null,
      expires_at timestamptz not null,
      consumed   boolean not null default false
    )`;
  await sql`create index if not exists mcp_session_nonce_address_idx on mcp_session_nonce (address)`;
  /// Retention: a nonce is usable for five minutes and worth keeping as evidence for a day.
  /// Nothing used to remove one, so the table grew for ever.
  await sql`delete from mcp_session_nonce where expires_at < now() - interval '1 day'`;
  ready = true;
}

export async function startSession(address: Address): Promise<{ nonceId: string; message: string; expiresAt: string }> {
  await ensureSchema();
  const id = randomUUID();
  const nonce = randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  await db()`
    insert into mcp_session_nonce (id, address, nonce, issued_at, expires_at)
    values (${id}, ${address.toLowerCase()}, ${nonce}, ${issuedAt}, ${expiresAt})`;
  return {
    nonceId: id,
    message: buildMessage(address, nonce, issuedAt),
    expiresAt: expiresAt.toISOString(),
  };
}

export type Session = { address: string; expires: number };export function mintToken(address: string): { session: string; expires: string } {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${address.toLowerCase()}.${expires}`;
  const signature = createHmac("sha256", SECRET).update(payload).digest("hex");
  return { session: `${payload}.${signature}`, expires: new Date(expires).toISOString() };
}

export function readToken(token: string | undefined): Session | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [address, expiresRaw, signature] = parts;
  const expected = createHmac("sha256", SECRET).update(`${address}.${expiresRaw}`).digest("hex");
  const given = Buffer.from(signature, "hex");
  const want = Buffer.from(expected, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || Date.now() > expires) return null;
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;

  return { address, expires };
}

export type FinishResult =
  | { ok: true; address: string; session: string; expires: string }
  | { ok: false; reason: string; fix?: string };

/// Verify a signature against the nonce that was issued for this address, then burn the nonce.
///
/// Verification goes through the chain client rather than bare ecrecover: an agent may be a smart
/// account (EIP-1271) or an EOA delegated under EIP-7702, and both would fail a plain recover.
export async function finishSession(
  address: Address,
  nonceId: string,
  signature: `0x${string}`,
): Promise<FinishResult> {
  await ensureSchema();
  const sql = db();
  const rows = await sql<
    { address: string; nonce: string; issued_at: Date; expires_at: Date; consumed: boolean }[]
  >`select address, nonce, issued_at, expires_at, consumed from mcp_session_nonce where id = ${nonceId} limit 1`;

  const row = rows[0];
  if (!row) return { ok: false, reason: "no such challenge", fix: "call pact_session_start again" };
  if (row.address !== address.toLowerCase()) {
    return { ok: false, reason: "this challenge was issued for a different address" };
  }
  if (row.consumed) return { ok: false, reason: "this challenge is already used", fix: "call pact_session_start again" };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "this challenge expired", fix: "call pact_session_start again" };
  }

  let valid = false;
  try {
    valid = await client.verifyMessage({
      address,
      message: buildMessage(address, row.nonce, new Date(row.issued_at).toISOString()),
      signature,
    });
  } catch {
    valid = false;
  }

  if (!valid) return { ok: false, reason: "the signature did not verify against this address" };

  /// Burn the challenge before returning, so a replayed signature cannot mint a second session.
  await sql`update mcp_session_nonce set consumed = true where id = ${nonceId} and consumed = false`;

  const { session, expires } = mintToken(address);
  return { ok: true, address: address.toLowerCase(), session, expires };
}
