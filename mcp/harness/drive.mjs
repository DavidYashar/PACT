// A small driver for the scenarios that need a wallet rather than a bug: post a job, accept a
// bid, read a job back. It is also how the feed gets seeded with real work.
//
//   node harness/drive.mjs whoami
//   node harness/drive.mjs register <name>
//   node harness/drive.mjs post <terms.json> <budget-wif> <bid-minutes> <delivery-minutes>
//   node harness/drive.mjs accept <jobId> <bidIndex>
//   node harness/drive.mjs job <jobId>

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const MCP_URL = process.env.PACT_MCP_URL ?? "http://localhost:8787/mcp";
const RPC_URL = process.env.PACT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.PACT_CHAIN_ID ?? 4663);
const KEY = process.env.PACT_DRIVE_KEY ?? process.env.PACT_DEPLOYER_KEY;

if (!KEY) throw new Error("PACT_DEPLOYER_KEY (or PACT_DRIVE_KEY) is not set");

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

const client = new Client({ name: "pact-drive", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

function text(result) {
  const first = result?.content?.[0];
  if (!first || first.type !== "text") throw new Error("no text content in tool result");
  if (result.isError) throw new Error(`tool failed: ${first.text}`);
  return JSON.parse(first.text);
}

const call = (name, args) => client.callTool({ name, arguments: args }).then(text);

function signSteps(steps) {
  return Promise.all(
    steps.map((step) =>
      wallet.signTransaction({
        to: step.to,
        data: step.data,
        value: BigInt(step.value),
        nonce: Number(step.nonce),
        gas: BigInt(step.gas),
        maxFeePerGas: BigInt(step.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(step.maxPriorityFeePerGas),
        chainId: step.chainId,
      }),
    ),
  );
}

async function run(args) {
  const planned = await call("pact_plan", { address: account.address, ...args });
  if (!planned.ok) throw new Error(`plan refused: ${planned.reason}${planned.fix ? ` (${planned.fix})` : ""}`);
  const done = await call("pact_submit", { intentId: planned.intentId, signed: await signSteps(planned.steps) });
  if (!done.ok) throw new Error(`submit failed: ${done.reason}`);
  for (const receipt of done.receipts ?? []) console.log(`  ${receipt.step}: ${receipt.hash} (${receipt.status})`);
  return done;
}

const [command, ...rest] = process.argv.slice(2);
console.log(`wallet ${account.address}`);

switch (command) {
  case "whoami": {
    console.log(JSON.stringify(await call("pact_whoami", { address: account.address }), null, 2));
    break;
  }
  case "register": {
    const name = rest[0];
    if (!name) throw new Error("register needs a name");
    const done = await run({ action: "register", name, kind: 1 });
    console.log(`registered @${name}: ${done.ok}`);
    break;
  }
  case "post": {
    const [file, budget, bidMinutes, deliveryMinutes] = rest;
    if (!file) throw new Error("post needs a terms file, a budget, and two windows in minutes");
    const terms = JSON.parse(readFileSync(file, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const done = await run({
      action: "post_job",
      terms,
      budget: (BigInt(Math.round(Number(budget) * 1e6)) * 10n ** 12n).toString(),
      bidDeadline: now + Number(bidMinutes ?? 60) * 60,
      deliveryDeadline: now + Number(deliveryMinutes ?? 1440) * 60,
    });
    console.log(`job ${done.jobId}`);
    break;
  }
  case "accept": {
    const [jobId, bidIndex] = rest;
    const done = await run({ action: "accept", jobId: Number(jobId), bidIndex: Number(bidIndex ?? 0) });
    console.log(JSON.stringify({ jobState: done.jobState, next: done.next }, null, 2));
    break;
  }
  case "job": {
    console.log(JSON.stringify(await call("pact_get_job", { jobId: Number(rest[0]) }), null, 2));
    break;
  }
  case "run": {
    const args = JSON.parse(readFileSync(rest[0], "utf8"));
    const done = await run(args);
    console.log(JSON.stringify({ ok: done.ok, jobState: done.jobState, next: done.next, published: done.published }, null, 2));
    break;
  }
  default: {
    console.log("commands: whoami | register <name> | post <terms.json> <budget> <bidMin> <deliveryMin> | accept <jobId> <bidIndex> | job <jobId>");
    process.exitCode = command ? 2 : 0;
  }
}

await client.close();
void publicClient;
