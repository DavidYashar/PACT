import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import { clientIp, RateLimiter } from "./rate-limit.js";
import { db } from "./db.js";
import { client } from "./chain.js";

/// Public-endpoint limits. Reads are cheap for us but not for the RPC. The one-plan-at-a-time rule
/// that protects `pact_plan` lives in the tool itself, against the intent ledger, so that a plan
/// refused for a reason the caller can fix never counts against them.
const perIp = new RateLimiter({ limit: 120, windowMs: 60_000 });
const perAddress = new RateLimiter({ limit: 60, windowMs: 60_000 });

/// `pact_submit` carries signed transactions, so the ceiling is generous but finite: an unbounded
/// body is a trivial way to exhaust the instance.
const LIMIT_BYTES = Number(process.env.PACT_MAX_BODY_BYTES ?? 256 * 1024);

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/// A refusal that happens before the transport is built still has to reach a client that only
/// reads server-sent events. Those requests accept `text/event-stream`, and a bare JSON body looks
/// to them like an empty response — a hang rather than a rate limit. So the same payload goes out
/// as one JSON-RPC error frame whenever the caller accepts a stream.
function refuse(
  res: ServerResponse,
  status: number,
  body: { error: string } & Record<string, unknown>,
  headers: Record<string, string> = {},
  id: string | number | null = null,
) {
  const accept = String(res.req?.headers.accept ?? "");
  if (accept.includes("text/event-stream")) {
    const frame = { jsonrpc: "2.0", id, error: { code: -32000, message: body.error, data: body } };
    res.writeHead(status, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
    return;
  }
  json(res, status, body, headers);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMIT_BYTES) throw new Error(`request body exceeds ${LIMIT_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/// The wallet a call is acting for, read out of the JSON-RPC envelope for accounting only. It is not
/// trusted for anything else: every tool re-derives authorisation from the chain.
function addressOf(body: unknown): string | null {
  const candidate = (body as { params?: { arguments?: { address?: unknown } } })?.params?.arguments?.address;
  return typeof candidate === "string" && /^0x[0-9a-fA-F]{40}$/.test(candidate) ? candidate.toLowerCase() : null;
}

/// The JSON-RPC id of the call, so a refusal sent as an event frame answers the request the client
/// is waiting on instead of arriving untagged.
function requestIdOf(body: unknown): string | number | null {
  const id = (body as { id?: unknown })?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/// Stateless streamable HTTP: every POST is a complete MCP exchange, so any instance can serve any
/// request. All the state that matters is on chain, and the intent ledger is in Postgres.
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    /// Liveness and readiness together. Render's health check should not pass while the database the
    /// intent ledger lives in is unreachable, or while the RPC is not answering: a deploy that cannot
    /// read the chain should be taken out of rotation rather than serve refusals.
    const checks: Record<string, unknown> = {};
    let ok = true;

    try {
      checks.chain = { head: (await client.getBlockNumber()).toString(), chainId: config.chainId };
    } catch (error) {
      ok = false;
      checks.chain = { error: String(error).slice(0, 200) };
    }

    try {
      await db()`select 1`;
      checks.database = "ok";
    } catch (error) {
      ok = false;
      checks.database = String(error).slice(0, 200);
    }

    json(res, ok ? 200 : 503, {
      ok,
      name: "pact-mcp",
      chainId: config.chainId,
      escrow: config.escrow,
      names: config.names,
      holdsKeys: false,
      checks,
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    json(res, 404, { error: "not found; the MCP endpoint is at /mcp" });
    return;
  }

  if (req.method !== "POST") {
    refuse(res, 405, { error: "use POST for the MCP endpoint" }, { allow: "POST" });
    return;
  }

  const ip = clientIp(new Headers(req.headers as Record<string, string>));
  const ipVerdict = perIp.take(ip);
  if (!ipVerdict.allowed) {
    refuse(
      res,
      429,
      { error: "too many requests from this address", retryAfterMs: ipVerdict.retryAfterMs },
      { "retry-after": String(Math.ceil(ipVerdict.retryAfterMs / 1000)) },
    );
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (error) {
    refuse(res, 413, { error: String(error) });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    refuse(res, 400, { error: "body is not JSON" });
    return;
  }

  const address = addressOf(parsed);
  if (address) {
    const verdict = perAddress.take(address);
    if (!verdict.allowed) {
      refuse(
        res,
        429,
        { error: `too many requests for ${address}`, retryAfterMs: verdict.retryAfterMs },
        { "retry-after": String(Math.ceil(verdict.retryAfterMs / 1000)) },
        requestIdOf(parsed),
      );
      return;
    }
  }

  // A fresh server per request: the transport is stateless, and nothing survives between calls
  // except what is written to the chain and to the intent ledger.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    /// The body was already read for accounting, so it is passed in rather than read again.
    await transport.handleRequest(req, res, parsed);
  } catch (error) {
    console.error("mcp request failed", error);
    if (!res.headersSent) refuse(res, 500, { error: "internal error" }, {}, requestIdOf(parsed));
  }
});

httpServer.listen(config.port, () => {
  console.log(`pact-mcp listening on :${config.port}`);
  console.log(`  chain     ${config.chainName} (${config.chainId})`);
  console.log(`  escrow    ${config.escrow}`);
  console.log(`  registry  ${config.names}`);
  console.log(`  keys held none`);
  console.log(`  limits    ${LIMIT_BYTES}-byte bodies, one pending plan per wallet`);
  console.log(`  sessions  signed with SESSION_SECRET (must match the web app)`);
});
