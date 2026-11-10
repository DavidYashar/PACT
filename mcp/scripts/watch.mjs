// Approve on match.
//
//   node scripts/watch.mjs --job 31 --key ../agents/agent-1/state/wallet.key
//   node scripts/watch.mjs --job 31 --key ./my.key --once
//
// A job can name the exact digest of the deliverable it will accept (`terms.expectedProofHash`).
// When it does, there is nothing left to judge: the delivery either reproduces that digest or the
// job is not done. This process watches a job and, the moment a delivery matches the commitment,
// plans and submits `release` from the employer's own wallet.
//
// This is deliberately a signer on the employer's side, not a feature of the escrow. The escrow
// cannot compare a proof to a commitment without being told to, and the whole design keeps every
// judgment and every signature outside the server. Running this means handing it the employer's
// key — the same key a human employer would use to click approve — so run it where that key is
// already trusted, and stop it when the job settles.
//
// It refuses to act on anything it cannot verify from the chain: the job must be DELIVERED, the
// on-chain proofHash must equal the committed hash, and the wallet must be the employer.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const jobId = Number(flag("job"));
const keyPath = flag("key") ?? process.env.PACT_APPROVER_KEY_FILE;
const once = has("once");
const pollSeconds = Number(flag("poll") ?? 10);

if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("--job <id> is required");
if (!keyPath) throw new Error("--key <path to a file holding the employer's private key> is required");

const MCP_URL = process.env.PACT_MCP_URL ?? "http://localhost:8787/mcp";
const RPC_URL = process.env.PACT_RPC_URL ?? "https://robinhood-rpc.publicnode.com";
const CHAIN_ID = Number(process.env.PACT_CHAIN_ID ?? 4663);

const raw = readFileSync(keyPath, "utf8").trim();
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
createPublicClient({ chain, transport: http(RPC_URL) });

const client = new Client({ name: "pact-approve-on-match", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

const text = (result) => {
  const first = result?.content?.[0];
  if (!first || first.type !== "text") throw new Error("no text content in tool result");
  if (result.isError) throw new Error(`tool failed: ${first.text}`);
  return JSON.parse(first.text);
};
const call = (name, params) => client.callTool({ name, arguments: params }).then(text);

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`${stamp()}  ${message}`);

log(`watching job ${jobId} as ${account.address}`);

const seen = await call("pact_get_job", { jobId });
if (!seen.found) throw new Error(`job ${jobId} does not exist`);
if (seen.employer.address.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(
    `this key is ${account.address} and the employer of job ${jobId} is ${seen.employer.address}: it cannot approve`,
  );
}
const expected = seen.terms?.expectedProofHash ?? null;
if (!expected) {
  throw new Error(
    `job ${jobId} names no expectedProofHash, so there is nothing to match. This job needs a judgment — approve it yourself, or let the resolver decide a ticket.`,
  );
}
log(`committed digest ${expected}`);
log(`the deliverable must hash to exactly that value; no other delivery will be approved`);

/// Claiming is wallet-wide, and it reverts until every settled job the wallet is party to has been
/// inscribed. A watcher that only records its own job therefore trips over the employer's other
/// work — so this walks every settled job of this wallet, inscribes the ones that are missing from
/// the registry, and only then lets `settle` claim.
async function recordEverythingSettled() {
  const listed = await call("pact_list_jobs", { employer: account.address, state: "SETTLED", limit: 50 });
  let inscribed = 0;
  for (const entry of listed.jobs ?? []) {
    const record = await call("pact_get_record", { jobId: entry.jobId });
    if (record.inscribed) continue;
    const planned = await call("pact_plan", { action: "settle", address: account.address, jobId: entry.jobId });
    if (!planned.ok) {
      log(`  could not settle job ${entry.jobId}: ${planned.reason}`);
      continue;
    }
    const signed = await signSteps(planned.steps);
    const done = await call("pact_submit", { intentId: planned.intentId, signed });
    if (done.ok) {
      inscribed += 1;
      log(`  inscribed job ${entry.jobId}`);
    } else {
      log(`  settle for job ${entry.jobId} failed: ${done.reason}`);
    }
  }
  return inscribed;
}

async function signSteps(steps) {
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

async function releaseAndRecord() {
  const planned = await call("pact_plan", { action: "release", address: account.address, jobId });
  if (!planned.ok) throw new Error(`plan refused: ${planned.reason}`);
  const done = await call("pact_submit", { intentId: planned.intentId, signed: await signSteps(planned.steps) });
  if (!done.ok) throw new Error(`submit failed: ${done.reason}`);
  for (const receipt of done.receipts ?? []) log(`  ${receipt.step}: ${receipt.hash} (${receipt.status})`);
  log(`job ${jobId} is ${done.jobState}`);
  await recordEverythingSettled();
  const closing = await call("pact_plan", { action: "settle", address: account.address, jobId });
  if (closing.ok) {
    const closed = await call("pact_submit", { intentId: closing.intentId, signed: await signSteps(closing.steps) });
    log(`  claim: ${closed.ok ? "done" : closed.reason}`);
  }
}

let waiting = true;
while (waiting) {
  const job = await call("pact_get_job", { jobId });

  if (job.state === "SETTLED") {
    log("already settled; clearing anything still blocking a claim");
    await recordEverythingSettled();
    const closing = await call("pact_plan", { action: "settle", address: account.address, jobId });
    if (closing.ok) {
      const closed = await call("pact_submit", { intentId: closing.intentId, signed: await signSteps(closing.steps) });
      log(`  claim: ${closed.ok ? "done" : closed.reason}`);
    } else {
      log(`  ${closing.reason}`);
    }
    waiting = false;
    break;
  }

  if (job.state === "DELIVERED") {
    const delivered = (job.proofHash ?? "").toLowerCase();
    if (delivered === expected.toLowerCase()) {
      log(`delivery matches: ${delivered}`);
      await releaseAndRecord();
      waiting = false;
      break;
    }
    log(`delivered, but the digest does not match — not approving. ${delivered}`);
    log("a mismatch is not a settlement: the employer still has to file a ticket, or the clock releases it");
    waiting = false;
    break;
  }

  if (job.state === "CANCELLED") {
    log("job is CANCELLED; nothing to approve");
    waiting = false;
    break;
  }

  if (job.state === "DISPUTED") {
    log("a ticket was filed; approval is closed and the resolver decides this one");
    waiting = false;
    break;
  }

  if (once) {
    log(`job is ${job.state}; nothing to approve in this pass`);
    waiting = false;
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
}

await client.close();
process.exit(0);
