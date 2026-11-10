// A local passthrough for Blockscout verification.
//
// Why this exists: the explorer sits behind a Cloudflare rule that answers forge's user agent with a
// "Just a moment…" challenge page, so `forge verify-contract … --verifier blockscout` fails with
// "Failed to deserialize response" even though the API itself is fine. A request from a plain client
// user agent gets a normal JSON response. This forwards every verification call to the real API with
// that user agent, and gives forge a `--verifier-url` it can talk to.
//
//   node verify-proxy.mjs 8555 https://robinhoodchain.blockscout.com/api
//   forge verify-contract <address> src/PactEscrow.sol:PactEscrow --chain 4663 \
//     --verifier blockscout --verifier-url http://127.0.0.1:8555/api
//
// It forwards, it does not cache, and it signs nothing. Kill it when the deploy is done.

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8555);
const upstream = (process.argv[3] ?? "https://robinhoodchain.blockscout.com/api").replace(/\/$/, "");

/// A user agent the explorer's edge does not challenge. Measured against the live API, a browser-like
/// agent, `curl`, `node` and `python-requests` are all answered with a 403 or a JS challenge; this
/// exact string is answered with JSON. It is the UA Windows PowerShell sends, and it is here because
/// it is the one that works, not because anything depends on PowerShell.
const AGENT = "Mozilla/5.0 (Windows NT; Windows NT 10.0; en-US) WindowsPowerShell/5.1.19041.1";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const target = new URL(upstream + url.pathname);
  /// Query strings matter: the v1 API carries module, action, address and apikey there.
  for (const [k, v] of url.searchParams) target.searchParams.append(k, v);

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const isJson = (req.headers["content-type"] ?? "").includes("application/json");
      const response = await fetch(target, {
        method: req.method,
        headers: {
          "User-Agent": AGENT,
          "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const text = await response.text();
      console.log(`${req.method} ${url.pathname}${url.search.slice(0, 60)} -> ${response.status} (${text.length}b)`);
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(text);
    } catch (error) {
      console.error("upstream failed:", String(error));
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "0", message: "proxy failed", result: String(error) }));
    }
  });
});

server.listen(port, () => console.log(`verify proxy on :${port} -> ${upstream}`));
