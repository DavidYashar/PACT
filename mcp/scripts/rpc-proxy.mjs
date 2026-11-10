// A JSON-RPC passthrough that adds the User-Agent the public Robinhood RPC requires.
//
// anvil --fork-url cannot send headers, and the chain's public RPC answers 403 without one, so a
// fork of mainnet has to go through this. Keep it running in one terminal and fork from it:
//
//   node scripts/rpc-proxy.mjs 8547 https://rpc.mainnet.chain.robinhood.com
//   anvil --fork-url http://127.0.0.1:8547 --port 8546
//   FORK_RPC=http://127.0.0.1:8546 node scripts/verify-swap-fork.mjs
//
// Nothing is cached and nothing is signed here: it forwards the body it is given.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8547);
const upstream = process.argv[3] ?? "https://rpc.mainnet.chain.robinhood.com";

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const response = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "pact-fork-proxy/1.0" },
        body,
      });
      const text = await response.text();
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(text);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(error) } }));
    }
  });
}).listen(port, () => console.log(`proxy on :${port} -> ${upstream}`));
