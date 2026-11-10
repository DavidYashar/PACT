import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createPublicClient, http } from "viem";
import { ESCROW_ADDRESS, activeChain } from "./chain";
import { pactAbi } from "./contract";

const ZERO = "0x0000000000000000000000000000000000000000";

/// Server-only secret used to sign session tokens. The web app and the MCP must share one value:
/// a token minted by the agent surface is presented to this app, and two different secrets would
/// make that token read as a forgery.
///
/// Fail closed rather than default. A built-in secret is a published secret — the value this file
/// used to carry is in the git history of any clone, so anyone could mint a session for any address.
/// In development an ephemeral secret is generated per process instead, which keeps `next dev`
/// working and makes a token minted before a restart invalid afterwards. That is the honest
/// behaviour: it is not security, and it does not pretend to be.
const PUBLISHED_SECRET = "pact-dev-session-secret-change-me-in-production";

function resolveSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured !== PUBLISHED_SECRET) {
    if (Buffer.byteLength(configured, "utf8") < 32) {
      throw new Error("SESSION_SECRET must be at least 32 bytes — generate one with `openssl rand -hex 32`");
    }
    return configured;
  }
  if (configured === PUBLISHED_SECRET) {
    throw new Error("SESSION_SECRET is the published development value — rotate it before serving");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is unset — the app cannot sign sessions");
  }
  return randomBytes(32).toString("hex");
}

const SECRET = resolveSecret();

export const SESSION_COOKIE = "pact_session";
export const NONCE_COOKIE = "pact_nonce";
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/// The exact string an operator signs. Built on the server so the client cannot
/// invent a different one, and rebuilt verbatim when the signature comes back.
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

export function signSession(address: string): { token: string; expires: number } {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${address.toLowerCase()}.${expires}`;
  const signature = createHmac("sha256", SECRET).update(payload).digest("hex");
  return { token: `${payload}.${signature}`, expires };
}

export function readSession(token: string | undefined): { address: string; expires: number } | null {
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

  return { address, expires };
}

function envAdmins(): string[] {
  return (process.env.ADMIN_ADDRESSES ?? process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value));
}

let cache: { at: number; set: Set<string> } | null = null;

/// Treasury and resolver are read from the contract so the set follows the deployment,
/// plus any address listed in ADMIN_ADDRESSES. Cached briefly — this runs per request.
export async function adminSet(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 30_000) return cache.set;

  const set = new Set<string>(envAdmins());

  try {
    const client = createPublicClient({ chain: activeChain, transport: http() });
    const [treasury, resolver] = await Promise.all([
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "treasury" }),
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "resolver" }),
    ]);

    for (const value of [treasury, resolver]) {
      if (typeof value === "string" && value.toLowerCase() !== ZERO) set.add(value.toLowerCase());
    }
  } catch {
    /// If the RPC is unreachable the env list still applies; never fail open.
  }

  cache = { at: Date.now(), set };
  return set;
}
