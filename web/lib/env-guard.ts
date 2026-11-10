import { ESCROW_ADDRESS, NAMES_ADDRESS } from "./chain";

/// Boot-time checks for a deployment.
///
/// Every one of these has a silent failure mode that looks like a product bug instead of a
/// configuration error: a zero escrow address renders an empty feed, a publishable-looking draft
/// secret issues tokens anyone can forge, a missing database quietly switches to a JSON file on a
/// disk that disappears on restart. A live deployment must refuse to answer rather than answer
/// wrongly, so each check throws with the variable to set.
///
/// Called from the server data path and from `next.config.ts`, so it fails at build *and* at
/// runtime. Client components never import this — `NEXT_PUBLIC_*` values are inlined at build time
/// and the same three checks live in the build assertion.
const ZERO = "0x0000000000000000000000000000000000000000";
/// The value this repository published for months. Anyone who has read the code can forge a session
/// token with it, so it is refused rather than warned about.
const PUBLISHED_SECRET = "pact-dev-session-secret-change-me-in-production";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/// Everything that must be true for the app to be allowed to serve anything.
export function assertDeployment(): void {
  const problems: string[] = [];

  if (ESCROW_ADDRESS.toLowerCase() === ZERO) problems.push("NEXT_PUBLIC_ESCROW_ADDRESS is unset or zero");
  if (NAMES_ADDRESS.toLowerCase() === ZERO) problems.push("NEXT_PUBLIC_NAMES_ADDRESS is unset or zero");

  const block = process.env.NEXT_PUBLIC_NAMES_DEPLOY_BLOCK;
  if (!block || !/^[0-9]+$/.test(block.trim())) {
    problems.push("NEXT_PUBLIC_NAMES_DEPLOY_BLOCK is unset or not a block number");
  }

  if (isProduction()) {
    if (!process.env.DATABASE_URL) {
      problems.push("DATABASE_URL is unset: the content store would fall back to a file on an ephemeral disk");
    }
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      problems.push("SESSION_SECRET is unset");
    } else if (secret === PUBLISHED_SECRET) {
      problems.push("SESSION_SECRET is the published development value; rotate it");
    } else if (Buffer.byteLength(secret, "utf8") < 32) {
      problems.push("SESSION_SECRET must be at least 32 bytes");
    }
  }

  if (problems.length) {
    throw new Error(
      `PACT refuses to start: ${problems.join("; ")}. See .env.example for every variable this needs.`,
    );
  }
}

/// The deploy block, as a BigInt, once it is known to be a number.
export function namesDeployBlock(): bigint {
  const raw = process.env.NEXT_PUBLIC_NAMES_DEPLOY_BLOCK ?? "";
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`NEXT_PUBLIC_NAMES_DEPLOY_BLOCK must be a block number, got "${raw}"`);
  }
  return BigInt(raw.trim());
}
