// Two agents, no SDK, no dependencies: only what SKILL.md tells an agent to use.
//
// The harness in run.mjs proves the server with the official MCP client and viem. This one proves
// something different and, for an outside agent, more useful: that the instructions in SKILL.md are
// sufficient. It talks JSON-RPC to /mcp with fetch, signs with `cast mktx` exactly as the document
// says, and keeps no state of its own beyond two private keys.
//
//   node harness/cold-agent.mjs
//
// Two independent wallets, two independent agents:
//   employer: register -> post a job -> accept -> release -> settle
//   worker:   register -> find the job -> bid -> deliver -> settle
//
// If this passes, an agent that can run curl and cast can use PACT.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const RPC = process.env.PACT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const MCP = process.env.PACT_MCP_URL ?? "http://localhost:8787/mcp";
const FUNDER_KEY = process.env.PACT_FUNDER_KEY;
const CHAIN_ID = Number(process.env.PACT_CHAIN_ID ?? 4663);
const WIF = process.env.PACT_WIF_ADDRESS ?? "0x5173b8eA6923c2d40267890D45C46a3480954773";
const GAS_FOR_AGENT = "0.0002ether";
const WIF_PER_AGENT = 1_000n * 10n ** 18n;

const cast = (...args) => execFileSync("cast", [...args, "--rpc-url", RPC], { encoding: "utf8" }).trim();
const castRaw = (...args) => execFileSync("cast", args, { encoding: "utf8" }).trim();

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    results.push(`  PASS  ${name}`);
  } else {
    failed++;
    results.push(`  FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

/// A JSON-RPC call over streamable HTTP. This is the whole MCP client an agent needs.
let id = 1;
async function tool(name, args) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.text();
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((message) => message.result || message.error);
  if (!data) throw new Error(`${name}: no result in ${body.slice(0, 200)}`);
  if (data.error) throw new Error(`${name}: ${data.error.message}`);
  if (data.result.isError) throw new Error(`${name}: ${data.result.content?.[0]?.text}`);
  return JSON.parse(data.result.content[0].text);
}

function newWallet(label) {
  const key = `0x${randomBytes(32).toString("hex")}`;
  const address = castRaw("wallet", "address", "--private-key", key);
  console.log(`  ${label}: ${address}`);
  return { label, key, address };
}

function fund(wallet) {
  if (!FUNDER_KEY) return;
  cast("send", wallet.address, "--value", GAS_FOR_AGENT, "--private-key", FUNDER_KEY, "--json");
}

function mintWif(wallet) {
  /// cast parses bare digit strings as JS numbers, which loses precision above 1e21 wei, so the
  /// amount goes in as a hex quantity.
  const amount = `0x${WIF_PER_AGENT.toString(16)}`;
  cast("send", WIF, "mint(address,uint256)", wallet.address, amount, "--private-key", wallet.key, "--json");
}

function wifBalance(address) {
  /// cast annotates large integers with a human-readable suffix ("… [1e21]"), which is not parseable
  /// as a number. Ask for JSON and read the raw quantity.
  const value = JSON.parse(castRaw("call", WIF, "balanceOf(address)(uint256)", address, "--rpc-url", RPC, "--json"));
  return BigInt(value);
}

/// The recipe from SKILL.md, verbatim: one cast invocation per prepared step. Everything the step
/// needs is passed explicitly, but cast still wants an endpoint to resolve the chain.
function signSteps(wallet, steps) {
  return steps.map((step) =>
    castRaw(
      "mktx",
      step.to,
      step.data,
      "--value",
      step.value,
      "--nonce",
      step.nonce,
      "--gas-limit",
      step.gas,
      "--gas-price",
      step.maxFeePerGas,
      "--private-key",
      wallet.key,
      "--chain",
      String(CHAIN_ID),
      "--rpc-url",
      RPC,
    ),
  );
}

async function run(wallet, action, extra = {}) {
  const plan = await tool("pact_plan", { action, address: wallet.address, ...extra });
  if (!plan.ok) return { ok: false, reason: plan.reason, fix: plan.fix };
  const signed = signSteps(wallet, plan.steps);
  return tool("pact_submit", { intentId: plan.intentId, signed });
}

function wif(whole) {
  return (BigInt(whole) * 10n ** 18n).toString();
}

async function main() {
  if (!FUNDER_KEY) {
    console.error("PACT_FUNDER_KEY is required: both agents need gas, and gas has to come from somewhere.");
    process.exit(1);
  }

  console.log("\nTwo agents, cold start. Nothing here is seeded.\n");
  const employer = newWallet("employer");
  const worker = newWallet("worker");
  console.log();

  for (const agent of [employer, worker]) {
    fund(agent);
    mintWif(agent);
  }
  check("both agents hold WIF and gas", wifBalance(employer.address) > 0n && wifBalance(worker.address) > 0n);

  // ---- rule 1: register first ----
  const employerReg = await run(employer, "register", { name: `emp${Math.floor(Math.random() * 1e6)}`, kind: 1 });
  check("employer registers", employerReg.ok === true, employerReg.reason);
  const workerReg = await run(worker, "register", { name: `wrk${Math.floor(Math.random() * 1e6)}`, kind: 1 });
  check("worker registers", workerReg.ok === true, workerReg.reason);

  // ---- the employer posts ----
  const now = Math.floor(Date.now() / 1000);
  const posted = await run(employer, "post_job", {
    terms: {
      title: "Two-agent end-to-end run",
      description: "Prove the loop from SKILL.md alone, with curl and cast.",
      criteria: "A job is posted, bid, accepted, delivered, released and recorded.",
      proofSpec: "The job id and the receipt hash, pasted where the employer can see them.",
      category: "test",
    },
    budget: wif(100),
    bidDeadline: now + 3600,
    deliveryDeadline: now + 86_400,
  });
  check("employer posts a job with terms", posted.ok === true, posted.reason);
  const jobId = posted.jobId;
  check("the terms are published with it", posted.published?.includes("terms"));
  console.log(`         job ${jobId} is open at ${wif(100)} WIF\n`);

  // ---- rule 5: check the deadline before bidding ----
  const open = await tool("pact_list_jobs", { state: "OPEN", biddableOnly: true, limit: 10 });
  check("the worker finds the job in the biddable feed", (open.jobs ?? []).some((j) => j.jobId === jobId));
  const detail = await tool("pact_get_job", { jobId });
  check("the worker can read the criteria before pricing", Boolean(detail.budget?.wif), JSON.stringify(detail.budget));

  // ---- the worker bids ----
  const bid = await run(worker, "bid", { jobId, price: wif(100), pitch: "Cold-start agent. I can do this in one pass." });
  check("worker bids", bid.ok === true, bid.reason);
  check("the pitch is published", bid.published?.includes("pitch"));

  // ---- acceptance pulls the bond in the employer's transaction ----
  const accepted = await run(employer, "accept", { jobId, worker: worker.address });
  check("employer accepts the bid", accepted.ok === true, accepted.reason);
  check("the job is ASSIGNED", accepted.jobState === "ASSIGNED", accepted.jobState);

  // ---- the worker delivers, and reads its own deliverable back through a session ----
  const deliverable =
    "Job complete. The two-agent run posted, bid, accepted, delivered, released and recorded this job. " +
    `Receipt: ${bid.receipts?.[0]?.hash ?? "see chain"}.`;
  const delivered = await run(worker, "deliver", { jobId, proof: deliverable });
  check("worker delivers", delivered.ok === true, delivered.reason);
  check("the deliverable is published", delivered.published?.includes("deliverable"));

  const challenge = await tool("pact_session_start", { address: worker.address });
  const signature = castRaw("wallet", "sign", challenge.message, "--private-key", worker.key);
  const session = await tool("pact_session_finish", {
    address: worker.address,
    nonceId: challenge.nonceId,
    signature,
  });
  check("the worker signs a session message with cast", typeof session.session === "string", session.reason);
  const file = await tool("pact_get_case", { jobId, session: session.session });
  check("the worker reads its own deliverable back", file.deliverable?.proof === deliverable, file.reason);

  // ---- release, then settle (record before claim) ----
  const released = await run(employer, "release", { jobId });
  check("employer releases the payment", released.ok === true, released.reason);

  const settled = await run(worker, "settle", { jobId });
  check("worker settles: record then claim", settled.ok === true, settled.reason);

  const record = await tool("pact_get_record", { jobId });
  check("the job is inscribed", record.inscribed === true);
  check(
    "the payout matches the table: price - 5% + the whole bond",
    record.paidToWorker?.wei === wif(145),
    `${record.paidToWorker?.wif} WIF (expected 145)`,
  );

  const after = await tool("pact_whoami", { address: worker.address });
  check("nothing is left claimable", after.claimable?.wei === "0", JSON.stringify(after.claimable));
  check("nothing blocks the next claim", after.claimBlocked === false);

  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`\nemployer  ${employer.address}\nworker    ${worker.address}\njob       ${jobId}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\ncold-agent crashed:", error.message);
  console.log("\n" + results.join("\n"));
  process.exit(1);
});
