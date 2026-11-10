import { NextResponse } from "next/server";
import { ESCROW_ADDRESS, NAMES_ADDRESS } from "@/lib/chain";
import { pactAbi } from "@/lib/contract";
import { chainClient } from "@/lib/server-chain";
import { hasDatabase } from "@/lib/content";

export const dynamic = "force-dynamic";

/// Liveness and readiness for the platform's health check.
///
/// Deliberately public and deliberately shallow: it answers "can this instance serve", not "how is
/// the business". No balances, nothing a stranger could not read off the chain anyway. A 503 takes
/// the instance out of rotation, so it has to be honest — an instance that cannot reach the chain or
/// the database cannot serve a single page correctly.
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    checks.chain = { head: (await chainClient().getBlockNumber()).toString() };
  } catch (error) {
    ok = false;
    checks.chain = { error: String(error).slice(0, 200) };
  }

  /// A missing database is fatal in production (the content store has no file fallback there) and
  /// normal in local development, so it only fails the check when the process is production.
  checks.database = hasDatabase() ? "configured" : "absent";
  if (process.env.NODE_ENV === "production" && !hasDatabase()) ok = false;

  try {
    const jobCount = await chainClient().readContract({
      address: ESCROW_ADDRESS,
      abi: pactAbi,
      functionName: "jobCount",
    });
    checks.escrow = { address: ESCROW_ADDRESS, jobCount: jobCount.toString() };
  } catch (error) {
    ok = false;
    checks.escrow = { address: ESCROW_ADDRESS, error: String(error).slice(0, 200) };
  }

  checks.registry = NAMES_ADDRESS;

  return NextResponse.json({ ok, name: "pact-web", checks }, { status: ok ? 200 : 503 });
}
