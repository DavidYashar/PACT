import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ESCROW_ADDRESS, NAMES_ADDRESS } from "@/lib/chain";
import { SESSION_COOKIE, adminSet, readSession } from "@/lib/session-server";
import { databaseStats, dbPing, hasDatabase } from "@/lib/content";
import { chainClient } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// Drift on a timer that should fire in ten milliseconds. This is the honest signal for CPU
/// starvation: a service can look calm in memory and still be queuing work, and on a 0.5 CPU box that
/// is exactly what happens first.
async function eventLoopLag(samples = 3): Promise<number> {
  let worst = 0;
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    worst = Math.max(worst, performance.now() - started - 10);
  }
  return Math.round(worst);
}

/// The operator's view of whether the deployment is healthy: the three moving parts, each measured
/// rather than assumed. Operator-only because it names endpoints and counts, but it exposes nothing
/// that is not already public on chain.
export async function GET() {
  const startedRoute = Date.now();
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

  /// Web: this process. Memory, uptime and how far behind its own timers it is.
  const memory = process.memoryUsage();
  const web: Record<string, unknown> = {
    status: "ok",
    rssMb: Math.round(memory.rss / 1_048_576),
    heapMb: Math.round(memory.heapUsed / 1_048_576),
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopLagMs: await eventLoopLag(),
  };

  /// Database: a bare round trip, which measures the connection rather than the row counts, then the
  /// counts themselves.
  const database: Record<string, unknown> = { configured: hasDatabase() };
  if (hasDatabase()) {
    try {
      database.pingMs = await dbPing();
      const started = Date.now();
      database.tables = await databaseStats();
      database.statsMs = Date.now() - started;
      database.status = "ok";
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
      const report = (await response.json().catch(() => null)) as {
        checks?: { chain?: { head?: string; chainId?: number }; database?: string };
        holdsKeys?: boolean;
      } | null;
      mcp.report = report;
      /// The MCP's own view, so a slow hop can be told apart from a slow chain read inside it.
      mcp.head = report?.checks?.chain?.head ?? null;
      mcp.database = report?.checks?.database ?? null;
      mcp.holdsKeys = report?.holdsKeys ?? null;
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
  };

  const ok = chain.status === "ok" && database.status === "ok" && mcp.status === "ok" && web.status === "ok";
  web.requestMs = Date.now() - startedRoute;
  return NextResponse.json({ ok, session: session.address, web, chain, database, mcp, configuration });
}
