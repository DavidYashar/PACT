import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ESCROW_ADDRESS, NAMES_ADDRESS } from "@/lib/chain";
import { SESSION_COOKIE, adminSet, readSession } from "@/lib/session-server";
import { databaseStats, hasDatabase } from "@/lib/content";
import { chainClient } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// The operator's view of whether the deployment is healthy: the three moving parts, each measured
/// rather than assumed. Operator-only because it names endpoints and counts, but it exposes nothing
/// that is not already public on chain.
export async function GET() {
  const store = await cookies();
  const session = readSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const admins = await adminSet();
  if (!admins.has(session.address.toLowerCase())) {
    return NextResponse.json({ error: "not an operator" }, { status: 403 });
  }

  /// Chain: the number every read depends on.
  const chain: Record<string, unknown> = {};
  const startedChain = Date.now();
  try {
    const head = await chainClient().getBlockNumber();
    chain.status = "ok";
    chain.head = head.toString();
    chain.latencyMs = Date.now() - startedChain;
  } catch (error) {
    chain.status = "error";
    chain.error = String(error).slice(0, 300);
  }

  /// Database: reachability and latency. `hasDatabase()` only says it is configured.
  const database: Record<string, unknown> = { configured: hasDatabase() };
  if (hasDatabase()) {
    const started = Date.now();
    try {
      database.tables = await databaseStats();
      database.status = "ok";
      database.latencyMs = Date.now() - started;
    } catch (error) {
      database.status = "error";
      database.error = String(error).slice(0, 300);
    }
  } else {
    database.status = "absent";
  }

  /// MCP: asked over HTTP, because the agent surface is a separate service and seeing the parts this
  /// process is not is the point of the panel.
  const mcp: Record<string, unknown> = { url: process.env.PACT_MCP_URL ?? "(unset)" };
  if (process.env.PACT_MCP_URL) {
    const started = Date.now();
    try {
      const response = await fetch(`${process.env.PACT_MCP_URL.replace(/\/$/, "")}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      mcp.status = response.ok ? "ok" : `http ${response.status}`;
      mcp.latencyMs = Date.now() - started;
      mcp.report = await response.json().catch(() => null);
    } catch (error) {
      mcp.status = "unreachable";
      mcp.error = String(error).slice(0, 200);
    }
  } else {
    mcp.status = "not configured";
  }

  /// Configuration: presence only, never the value — this response crosses the wire.
  const configuration = {
    escrow: ESCROW_ADDRESS,
    registry: NAMES_ADDRESS,
    deployBlock: process.env.NEXT_PUBLIC_NAMES_DEPLOY_BLOCK ?? "(unset)",
    rpc: process.env.RPC_URL ? "configured" : "chain default",
    logsRpc: process.env.LOGS_RPC_URL ? "configured" : "chain default",
    sessionSecret: process.env.SESSION_SECRET ? "configured" : "MISSING",
    nodeEnv: process.env.NODE_ENV ?? "development",
    uptimeSeconds: Math.round(process.uptime()),
  };

  const ok = chain.status === "ok" && database.status === "ok" && mcp.status === "ok";
  return NextResponse.json({ ok, session: session.address, chain, database, mcp, configuration });
}
