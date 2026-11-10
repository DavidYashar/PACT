// Scenario harness: the paths the happy-path harness never walks.
//
// Every assertion is made against the chain, not against what a tool told us. Where a tool is
// expected to refuse, the same call is also forced onto the wire with its own gas limit so the
// contract's own guard is what rejects it — a refusal in the planner proves nothing about the
// escrow.
//
//   bid on a closed window        the planner refuses, and bid() reverts with BidWindowClosed
//   accept an unfunded bond       the planner refuses, and acceptBid() reverts atomically
//   cancel and refund             the budget comes back with no cut taken
//   abandon                       price refund minus the cut, plus the whole bond, to the employer
//   release after silence         blocked before autoReleaseAt, then pays on its own
//   resolver is a party           the ruling is refused while the resolver holds a stake
//   two accepts, same instant     exactly one lands; one bond is pulled, not two

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWalletClient, createPublicClient, http, formatEther, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MCP_URL = process.env.PACT_MCP_URL ?? "http://localhost:8787/mcp";
const RPC_URL = process.env.PACT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.PACT_CHAIN_ID ?? 4663);
const ESCROW = process.env.PACT_ESCROW_ADDRESS;
const WIF = process.env.PACT_WIF_ADDRESS ?? "0x5173b8eA6923c2d40267890D45C46a3480954773";
const DEPLOYER_KEY = process.env.PACT_DEPLOYER_KEY;

if (!ESCROW) throw new Error("PACT_ESCROW_ADDRESS is not set");
if (!DEPLOYER_KEY) throw new Error("PACT_DEPLOYER_KEY is required: it funds gas and acts as the resolver");

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

const escrowErrors = [
  "NotEmployer", "NotWorker", "NotParty", "NotResolver", "WrongState", "BidWindowClosed",
  "PastDeadline", "NotYetReleasable", "ZeroAmount", "PriceTooHigh", "BadDeadline", "SelfJob",
  "BidUnavailable", "FineTooHigh", "ResolverIsParty", "NotRegistry", "RecordPending",
  "AlreadyRecorded", "NotRegistered", "BondUnfunded", "DelayOutOfRange",
].map((name) => ({ type: "error", name, inputs: [] }));

/// A bond that cannot be pulled fails inside the token, so the error that surfaces belongs to
/// ERC-20, not to the escrow. Declaring it here is what lets the revert be named rather than
/// reported as a bare selector.
const tokenErrors = [
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "sender", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
];

const escrowAbi = [
  { type: "function", name: "bid", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "price", type: "uint256" }], outputs: [] },
  { type: "function", name: "acceptBid", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "bidIndex", type: "uint256" }], outputs: [] },
  { type: "function", name: "releaseExpired", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { type: "function", name: "resolveDispute", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "ruling", type: "uint8" }, { name: "fineBps", type: "uint16" }], outputs: [] },
  { type: "function", name: "transferResolver", stateMutability: "nonpayable", inputs: [{ name: "next", type: "address" }], outputs: [] },
  { type: "function", name: "resolver", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  ...escrowErrors,
];

const wifAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  ...tokenErrors,
];

/// The escrow's own errors, so viem can name a revert instead of handing back a bare selector.
const SELECTOR_NAMES = {
  "0x05cb04e2": "NotEmployer",
  "0xfb55adaf": "NotWorker",
  "0xc8ee2d1d": "NotParty",
  "0xba2a9fc2": "NotResolver",
  "0xde4168ba": "WrongState",
  "0xa46e86a1": "BidWindowClosed",
  "0x81efbd8d": "PastDeadline",
  "0xf46f6ef6": "NotYetReleasable",
  "0x1f2a2005": "ZeroAmount",
  "0x24fe1192": "PriceTooHigh",
  "0x710e1ce5": "BadDeadline",
  "0xf772ee7f": "SelfJob",
  "0xbc37a6f3": "BidUnavailable",
  "0x6c90ebc5": "FineTooHigh",
  "0x58893a17": "ResolverIsParty",
  "0xc85d9d6c": "NotRegistry",
  "0x74a85ec3": "RecordPending",
  "0x103b4afe": "AlreadyRecorded",
  "0xaba47339": "NotRegistered",
  "0x140b6064": "BondUnfunded",
  "0x685b79ac": "DelayOutOfRange",
  "0xfb8f41b2": "ERC20InsufficientAllowance",
  "0xe450d38c": "ERC20InsufficientBalance",
  "0x5274afe7": "SafeERC20FailedOperation",
};

let passed = 0;
let failed = 0;
const results = [];
const receipts = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    results.push(`  PASS  ${name}`);
  } else {
    failed++;
    results.push(`  FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

function text(result) {
  const first = result?.content?.[0];
  if (!first || first.type !== "text") throw new Error("no text content in tool result");
  if (result.isError) throw new Error(`tool failed: ${first.text}`);
  return JSON.parse(first.text);
}

/// Tool arguments travel as JSON, and JSON has no BigInt. Converting here means a plan can be
/// written with the same values the chain wants without every call site remembering to stringify.
function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

async function call(client, name, args) {
  return text(await client.callTool({ name, arguments: jsonSafe(args) }));
}

function signSteps(wallet, steps) {
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

/// viem buries the interesting part of a revert in the cause chain.
function describe(error) {
  const parts = [];
  let cursor = error;
  for (let depth = 0; cursor && depth < 6; depth++) {
    if (cursor.shortMessage) parts.push(cursor.shortMessage);
    else if (cursor.message) parts.push(cursor.message);
    if (cursor.data?.errorName) parts.push(cursor.data.errorName);
    cursor = cursor.cause;
  }
  return [...new Set(parts)].join(" | ");
}

function errorName(reason) {
  const known = [
    "BidWindowClosed",
    "BondUnfunded",
    "WrongState",
    "NotYetReleasable",
    "ResolverIsParty",
    "NotResolver",
    "RecordPending",
    "ZeroAmount",
    "NotRegistered",
    "SelfJob",
    "PriceTooHigh",
    "BidUnavailable",
    "SafeERC20FailedOperation",
    "ERC20InsufficientBalance",
    "ERC20InsufficientAllowance",
    "execution reverted",
  ];
  const found = known.filter((name) => reason.includes(name));
  if (found.length > 0) return found.join("+");

  /// viem leaves a bare selector behind when the ABI it was handed has no matching error.
  const selectors = [...reason.matchAll(/0x[0-9a-fA-F]{8}/g)].map((match) => match[0].toLowerCase());
  const named = selectors.map((selector) => SELECTOR_NAMES[selector]).filter(Boolean);
  if (named.length > 0) return [...new Set(named)].join("+");

  return reason.slice(0, 120);
}

const wif = (whole) => BigInt(whole) * 10n ** 18n;
const human = (wei) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });

const GAS_PER_ACTOR = 30_000_000_000_000n;

/// The alternate resolver for the handover test. It is persisted on disk so that a run which
/// stops half way can still give the role back; a throwaway key would strand it forever.
function alternateResolverKey() {
  const path = new URL("./.alt-resolver.key", import.meta.url);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = generatePrivateKey();
  writeFileSync(path, key);
  return key;
}

async function main() {
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC_URL) });
  console.log(`escrow     ${ESCROW}`);
  console.log(`deployer   ${deployer.address} (${formatEther(await publicClient.getBalance({ address: deployer.address }))} ETH)\n`);

  async function balanceOf(address) {
    return publicClient.readContract({ address: WIF, abi: wifAbi, functionName: "balanceOf", args: [address] });
  }

  const client = new Client({ name: "pact-scenarios", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  console.log("connected to the MCP server\n");

  async function fundActor(address) {
    const hash = await deployerWallet.sendTransaction({ to: address, value: GAS_PER_ACTOR });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function spawn(label, options = { wif: 2_000, register: true }) {
    const account = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
    await fundActor(account.address);
    if (options.wif > 0) {
      const mintHash = await wallet.writeContract({ address: WIF, abi: wifAbi, functionName: "mint", args: [account.address, wif(options.wif)] });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
    }
    const actor = { label, account, wallet, name: null };
    if (options.register) {
      const name = `${label}${Math.floor(Math.random() * 1e6)}`;
      const planned = await call(client, "pact_plan", { action: "register", address: account.address, name, kind: 1 });
      if (!planned.ok) throw new Error(`${label} register plan failed: ${planned.reason}`);
      const done = await call(client, "pact_submit", { intentId: planned.intentId, signed: await signSteps(wallet, planned.steps) });
      if (!done.ok) throw new Error(`${label} register failed: ${done.reason}`);
      actor.name = name;
    }
    console.log(`  ${label.padEnd(9)} ${account.address} @${actor.name ?? "-"} ${options.wif > 0 ? human(wif(options.wif)) + " WIF" : "0 WIF"}`);
    return actor;
  }

  async function submitPlan(who, args, label, options = { expectFailure: false }) {
    /// Every actor starts with a fixed gas float. A run places a dozen transactions per wallet, so
    /// rather than guess a total up front, top the wallet up whenever it runs low.
    const gas = await publicClient.getBalance({ address: who.account.address });
    if (gas < GAS_PER_ACTOR / 2n) {
      const hash = await deployerWallet.sendTransaction({ to: who.account.address, value: GAS_PER_ACTOR });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    const planned = await call(client, "pact_plan", { address: who.account.address, ...args });
    if (!planned.ok) {
      if (!options.expectFailure) check(`${label}: plans`, false, planned.reason);
      return { ok: false, reason: planned.reason, planned: null };
    }
    const done = await call(client, "pact_submit", { intentId: planned.intentId, signed: await signSteps(who.wallet, planned.steps) });
    if (!options.expectFailure) check(`${label}: lands`, done.ok === true, done.reason);
    for (const r of done.receipts ?? []) {
      receipts.push(`${label}: ${r.step} ${r.hash} (${r.status})`);
    }
    return done;
  }

  /// Force the call onto the chain with a fixed gas limit, so nothing estimates or simulates it
  /// first. Used to prove that the contract itself is the thing refusing. A reverted receipt is
  /// not enough on its own — the call is replayed to name the error, because "it reverted" is also
  /// what a wrong function or an empty account looks like.
  async function forceRevert(who, functionName, args, label, expected) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName, args });
    const alternatives = expected.split("|");
    try {
      const hash = await who.wallet.sendTransaction({ to: ESCROW, data, gas: 600_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "reverted") {
        check(`${label} reverts with ${expected}`, false, `the chain accepted it: ${hash}`);
        return false;
      }
      receipts.push(`${label} (reverted, gas paid) ${hash}`);
      const replayed = await replayError(who, functionName, args, receipt.blockNumber);
      check(`${label} reverts with ${expected}`, alternatives.some((alternative) => replayed.includes(alternative)), replayed);
      return true;
    } catch (error) {
      const named = errorName(describe(error));
      check(`${label} reverts with ${expected}`, alternatives.some((alternative) => named.includes(alternative)), named);
      return true;
    }
  }

  async function replayError(who, functionName, args, blockNumber) {
    try {
      await publicClient.simulateContract({
        account: who.account,
        address: ESCROW,
        abi: escrowAbi,
        functionName,
        args,
        blockNumber: blockNumber - 1n,
      });
      return "no error on replay";
    } catch (error) {
      return errorName(describe(error));
    }
  }

  const now = () => Math.floor(Date.now() / 1000);
  const termsFor = (title) => ({
    title,
    description: `${title}. Delivered as described in the criteria.`,
    criteria: "The deliverable exists, matches the brief, and the proof links to it.",
    proofSpec: "A URL that loads without a login, plus a hash of the file.",
    category: "test",
  });

  console.log("spawning actors");
  const employer = await spawn("employer", { wif: 6_000, register: true });  const worker = await spawn("worker", { wif: 4_000, register: true });
  const rival = await spawn("rival", { wif: 4_000, register: true });
  const broke = await spawn("broke", { wif: 0, register: true });
  console.log("");

  // ---------------------------------------------------------------- the 30-minute clock
  // Started first because the wait runs in the background of every other scenario.
  console.log("-- release after silence: starting the clock");
  const clockTerms = termsFor("Silence test: the employer goes quiet after delivery");
  const clockPost = await submitPlan(
    employer,
    { action: "post_job", terms: clockTerms, budget: wif(1_000), bidDeadline: now() + 3_600, deliveryDeadline: now() + 86_400 },
    "clock job posted",
  );
  const clockJob = clockPost?.jobId;
  if (!clockJob) throw new Error("the clock job could not be posted");
  await submitPlan(worker, { action: "bid", jobId: clockJob, price: wif(1_000), pitch: "Delivered in minutes." }, "clock job bid");
  await submitPlan(worker, { action: "approve", amount: wif(500).toString() }, "clock bond approved");
  const clockAccept = await submitPlan(employer, { action: "accept", jobId: clockJob, bidIndex: 0 }, "clock bid accepted");
  check("accept pulls the worker's bond in the same transaction", clockAccept?.jobState === "ASSIGNED", clockAccept?.jobState);
  await submitPlan(worker, { action: "deliver", jobId: clockJob, proof: "Delivered. Nobody is going to answer." }, "clock delivery");

  // The delivery receipt mined at a known time; the job carries its own window, so the release
  // time is read back from the job rather than assumed from a deployment-wide constant.
  const deliveredAt = BigInt(now());
  const clockJobNow = await call(client, "pact_get_job", { jobId: clockJob });
  const delay = BigInt(clockJobNow.autoReleaseSeconds ?? 0);
  const autoReleaseAt = deliveredAt + delay;
  console.log(`         -> window ${delay}s, expected release after ${new Date(Number(autoReleaseAt) * 1000).toISOString()}\n`);

  // ---------------------------------------------------------------- a bid on a closed window
  /// Everything from here to the finale runs inside one guard: a bug in one scenario must not
  /// throw away the thirty minutes the clock has already been running.
  try {
  console.log("-- bid on a closed window");
  const closedPost = await submitPlan(
    employer,
    { action: "post_job", terms: termsFor("Short window job"), budget: wif(100), bidDeadline: now() + 40, deliveryDeadline: now() + 86_400 },
    "short-window job posted",
  );
  const closedJob = closedPost?.jobId;
  check("a 40-second bid window is accepted at posting time", Boolean(closedJob), closedPost?.reason);
  if (closedJob) {
    const waitMs = 50_000;
    console.log(`         -> waiting ${waitMs / 1000}s for the window to close`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const jobNow = await call(client, "pact_get_job", { jobId: closedJob });
    check("the job reports it is no longer biddable", jobNow.biddable === false, JSON.stringify(jobNow.biddable));
    check("the job is still OPEN on chain", jobNow.state === "OPEN", jobNow.state);

    const latePlan = await call(client, "pact_plan", { action: "bid", address: worker.account.address, jobId: closedJob, price: wif(100) });
    check("the planner refuses a bid on a closed window", latePlan.ok === false, latePlan.reason);
    console.log(`         -> ${latePlan.reason}`);

    await forceRevert(worker, "bid", [BigInt(closedJob), wif(100)], "bid after the window closed", "BidWindowClosed");

    const acceptedLate = await submitPlan(employer, { action: "accept", jobId: closedJob, bidIndex: 0 }, "accept a bid nobody placed", { expectFailure: true });
    check("there is no bid to accept on the closed job", acceptedLate.ok === false, acceptedLate.reason);

    await submitPlan(employer, { action: "cancel", jobId: closedJob }, "cancel the expired-window job");
    // Claim it now, so later refund measurements are not polluted by a credit left sitting here.
    const refundBefore = await balanceOf(employer.account.address);
    await submitPlan(employer, { action: "settle", jobId: closedJob }, "claim the expired-window refund");
    const refundAfter = await balanceOf(employer.account.address);
    check("cancelling refunds the whole budget", refundAfter - refundBefore === wif(100), `${human(refundAfter - refundBefore)} WIF (expected 100)`);
  }

  // ---------------------------------------------------------------- an unfunded bid
  console.log("\n-- accept a bid whose bond cannot be paid");
  const brokePost = await submitPlan(
    employer,
    { action: "post_job", terms: termsFor("Unfunded bond job"), budget: wif(300), bidDeadline: now() + 3_600, deliveryDeadline: now() + 86_400 },
    "unfunded-bond job posted",
  );
  const brokeJob = brokePost?.jobId;
  if (brokeJob) {
    const before = await balanceOf(broke.account.address);
    check("the broke worker holds no WIF", before === 0n, human(before));

    const brokePlan = await call(client, "pact_plan", { action: "bid", address: broke.account.address, jobId: brokeJob, price: wif(300) });
    check("the planner refuses a bid the wallet cannot bond", brokePlan.ok === false, brokePlan.reason);
    console.log(`         -> ${brokePlan.reason}`);

    // The escrow refuses it too, at bid time: an unfunded bid is a trap for the employer,
    // because acceptBid pulls the bond inside the employer's own transaction.
    await forceRevert(broke, "bid", [BigInt(brokeJob), wif(300)], "a bid from a wallet with no WIF", "BondUnfunded");

    const noBids = await call(client, "pact_get_job", { jobId: brokeJob });
    check("no bid was recorded", (noBids.bids?.length ?? 0) === 0, JSON.stringify(noBids.bids?.length));

    // A bond that exists at bid time can still be gone by accept time. That is what acceptBid
    // has to survive, and it has to survive it without leaving half a job behind.
    await submitPlan(worker, { action: "bid", jobId: brokeJob, price: wif(300), pitch: "Funded when I bid." }, "a funded bid");
    await submitPlan(worker, { action: "approve", amount: wif(150).toString() }, "the bond allowance");
    const revoke = await worker.wallet.writeContract({ address: WIF, abi: wifAbi, functionName: "approve", args: [ESCROW, 0n] });
    await publicClient.waitForTransactionReceipt({ hash: revoke });
    receipts.push(`revoked the bond allowance ${revoke}`);
    const workerWifBefore = await balanceOf(worker.account.address);

    const wouldAccept = await call(client, "pact_plan", { action: "accept", address: employer.account.address, jobId: brokeJob, bidIndex: 0 });
    check("the planner refuses to accept a bid whose allowance was withdrawn", wouldAccept.ok === false, wouldAccept.reason);
    console.log(`         -> ${wouldAccept.reason}`);

    await forceRevert(employer, "acceptBid", [BigInt(brokeJob), 0n], "accepting a bid whose bond cannot be pulled", "SafeERC20FailedOperation|ERC20InsufficientAllowance|ERC20InsufficientBalance");

    const stateAfter = await call(client, "pact_get_job", { jobId: brokeJob });
    check("the failed accept leaves the job OPEN", stateAfter.state === "OPEN", stateAfter.state);
    check("no worker was recorded", stateAfter.worker === null, JSON.stringify(stateAfter.worker));
    check("the bid was not marked accepted", stateAfter.bids?.[0]?.accepted === false, JSON.stringify(stateAfter.bids?.[0]?.accepted));
    const workerAfterFailed = await balanceOf(worker.account.address);
    check("the failed accept moved no WIF", workerAfterFailed === workerWifBefore, `${human(workerAfterFailed)} WIF`);

    // And the job is still usable once the worker puts the allowance back.
    await submitPlan(worker, { action: "approve", amount: wif(150).toString() }, "the bond allowance, restored");
    const recovered = await submitPlan(employer, { action: "accept", jobId: brokeJob, bidIndex: 0 }, "accept after the allowance is restored");
    check("the job accepts normally once the bond is fundable", recovered?.jobState === "ASSIGNED", recovered?.jobState);
    await submitPlan(worker, { action: "abandon", jobId: brokeJob }, "abandon the recovered job to clean up");

    const employerBefore = await balanceOf(employer.account.address);
    await submitPlan(employer, { action: "settle", jobId: brokeJob }, "claim the abandoned-job refund");
    const employerAfter = await balanceOf(employer.account.address);
    check(
      "an abandoned job returns the price less the cut plus the whole bond",
      employerAfter - employerBefore === wif(435),
      `${human(employerAfter - employerBefore)} WIF returned (expected 435: 300 price less a 15 cut, plus a 150 bond)`,
    );
  }

  // ---------------------------------------------------------------- abandon
  console.log("\n-- abandon: the worker walks away after bonding");
  const employerBeforeAbandon = await balanceOf(employer.account.address);
  const abandonPost = await submitPlan(
    employer,
    { action: "post_job", terms: termsFor("Abandoned job"), budget: wif(1_000), bidDeadline: now() + 3_600, deliveryDeadline: now() + 86_400 },
    "abandon job posted",
  );
  const abandonJob = abandonPost?.jobId;
  if (abandonJob) {
    await submitPlan(worker, { action: "bid", jobId: abandonJob, price: wif(1_000), pitch: "Easy." }, "abandon bid placed");
    await submitPlan(worker, { action: "approve", amount: wif(500).toString() }, "abandon bond approved");
    const workerBefore = await balanceOf(worker.account.address);
    await submitPlan(employer, { action: "accept", jobId: abandonJob, bidIndex: 0 }, "abandon bid accepted");
    const workerBonded = await balanceOf(worker.account.address);
    check("the bond leaves the worker's wallet on accept", workerBefore - workerBonded === wif(500), `${human(workerBefore - workerBonded)} WIF bonded`);

    await submitPlan(worker, { action: "abandon", jobId: abandonJob }, "worker abandons");
    const abandonment = await call(client, "pact_get_job", { jobId: abandonJob });
    check("abandoning settles the job", abandonment.state === "SETTLED", abandonment.state);
    check("the record says the worker did not win", abandonment.settlement?.workerWon === false, JSON.stringify(abandonment.settlement?.workerWon));
    check(
      "the employer is credited the price minus the cut plus the whole bond",
      abandonment.settlement?.creditedToEmployer?.wei === wif(1_450).toString(),
      `${abandonment.settlement?.creditedToEmployer?.wif} WIF`,
    );
    check("the worker is credited nothing", abandonment.settlement?.creditedToWorker?.wei === "0", JSON.stringify(abandonment.settlement?.creditedToWorker));

    // A settlement that is not yet inscribed locks every claim the wallet has, not just this job's.
    await forceRevert(worker, "claim", [], "claiming while a settled job is unrecorded", "RecordPending");

    await submitPlan(employer, { action: "settle", jobId: abandonJob }, "record and claim the abandon refund");
    const employerAfter = await balanceOf(employer.account.address);
    check(
      "the employer ends 450 WIF up: a 1,000 price refunded less the cut plus a 500 bond",
      employerAfter - employerBeforeAbandon === wif(450),
      `${human(employerAfter - employerBeforeAbandon)} WIF (expected 450)`,
    );
    const workerAfter = await balanceOf(worker.account.address);
    check("the worker ends 500 WIF down", workerAfter - workerBefore === -wif(500), `${human(workerAfter - workerBefore)} WIF`);
  }

  // ---------------------------------------------------------------- resolver is a party
  console.log("\n-- the resolver holds a stake in the job it is asked to rule on");
  // The resolver is the deployer key, so the deployer has to be the employer here.
  const deployerActor = { label: "deployer", account: deployer, wallet: deployerWallet };
  const mintToDeployer = await deployerWallet.writeContract({ address: WIF, abi: wifAbi, functionName: "mint", args: [deployer.address, wif(1_000)] });
  await publicClient.waitForTransactionReceipt({ hash: mintToDeployer });
  const deployerName = `resolver${Math.floor(Math.random() * 1e6)}`;
  const regPlan = await call(client, "pact_plan", { action: "register", address: deployer.address, name: deployerName, kind: 0 });
  if (regPlan.ok) {
    await call(client, "pact_submit", { intentId: regPlan.intentId, signed: await signSteps(deployerWallet, regPlan.steps) });
  }

  const resolverPost = await submitPlan(
    deployerActor,
    { action: "post_job", terms: termsFor("A job the resolver is party to"), budget: wif(200), bidDeadline: now() + 3_600, deliveryDeadline: now() + 86_400 },
    "resolver-as-employer job posted",
  );
  const resolverJob = resolverPost?.jobId;
  if (resolverJob) {
    await submitPlan(worker, { action: "bid", jobId: resolverJob, price: wif(200), pitch: "Same day." }, "bid on the resolver's job");
    await submitPlan(worker, { action: "approve", amount: wif(100).toString() }, "bond approved for the resolver's job");
    await submitPlan(deployerActor, { action: "accept", jobId: resolverJob, bidIndex: 0 }, "resolver's job accepted");
    await submitPlan(worker, { action: "deliver", jobId: resolverJob, proof: "Delivered the thing that was asked for, on time and as described." }, "deliver to the resolver's job");
    await submitPlan(deployerActor, { action: "raise_ticket", jobId: resolverJob, reason: "This is not what was asked for." }, "resolver files a ticket on their own job");

    const selfRule = await call(client, "pact_plan", { action: "resolve", address: deployer.address, jobId: resolverJob, ruling: "employer" });
    check("the planner refuses to let a party rule on their own ticket", selfRule.ok === false, selfRule.reason);
    console.log(`         -> ${selfRule.reason}`);

    await forceRevert(deployerActor, "resolveDispute", [BigInt(resolverJob), 1, 0], "a ruling by a party", "ResolverIsParty");

    const stillDisputed = await call(client, "pact_get_job", { jobId: resolverJob });
    check("the job is still DISPUTED after the refused ruling", stillDisputed.state === "DISPUTED", stillDisputed.state);

    // Hand the role out and back, which is the documented way to unstick a job like this. The
    // alternate resolver's key is persisted, because a handover to a throwaway key is exactly how
    // the previous escrow lost its resolver: a run that aborted between hand-out and hand-back
    // left the role with a wallet nobody could sign for again.
    const altKey = alternateResolverKey();
    const altAccount = privateKeyToAccount(altKey);
    await fundActor(altAccount.address);
    const altWallet = createWalletClient({ account: altAccount, chain, transport: http(RPC_URL) });
    const alt = { label: "alt", account: altAccount, wallet: altWallet, name: null };

    const handOver = await deployerWallet.writeContract({ address: ESCROW, abi: escrowAbi, functionName: "transferResolver", args: [altAccount.address] });
    await publicClient.waitForTransactionReceipt({ hash: handOver });
    const handed = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "resolver" });
    check("the resolver role moves by transaction", handed.toLowerCase() === altAccount.address.toLowerCase(), handed);

    try {
      await submitPlan(alt, { action: "resolve", jobId: resolverJob, ruling: "worker", fineBps: 0, note: "The employer had no complaint that the criteria cover." }, "an independent resolver rules");
      const workerBeforeRuling = await balanceOf(worker.account.address);
      await submitPlan(worker, { action: "settle", jobId: resolverJob }, "record and claim the ruling");
      const workerAfterRuling = await balanceOf(worker.account.address);
      check(
        "a won ticket pays the price minus the cut plus the bond",
        workerAfterRuling - workerBeforeRuling === wif(290),
        `${human(workerAfterRuling - workerBeforeRuling)} WIF received (expected 290 for a 200 price and a 100 bond)`,
      );

      // The handover is a handover: the previous resolver cannot take the role back. Only the
      // wallet that holds it can give it up, which is what makes a compromised resolver key
      // containable — and what makes a bad handover unrecoverable without the new holder.
      await forceRevert(deployerActor, "transferResolver", [deployer.address], "the old resolver taking the role back", "NotResolver");
    } finally {
      const holder = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "resolver" });
      if (holder.toLowerCase() === altAccount.address.toLowerCase()) {
        const giveBack = await altWallet.writeContract({ address: ESCROW, abi: escrowAbi, functionName: "transferResolver", args: [deployer.address] });
        await publicClient.waitForTransactionReceipt({ hash: giveBack });
      }
    }

    const back = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "resolver" });
    check("the resolver role comes back to the deployer when the holder returns it", back.toLowerCase() === deployer.address.toLowerCase(), back);
  }

  // ---------------------------------------------------------------- two accepts at once
  console.log("\n-- two accepts for the same job, broadcast together");
  const racePost = await submitPlan(
    employer,
    { action: "post_job", terms: termsFor("Race job"), budget: wif(400), bidDeadline: now() + 3_600, deliveryDeadline: now() + 86_400 },
    "race job posted",
  );
  const raceJob = racePost?.jobId;
  if (raceJob) {
    await submitPlan(worker, { action: "bid", jobId: raceJob, price: wif(400), pitch: "Cheaper and faster." }, "first racer bids");
    await submitPlan(rival, { action: "bid", jobId: raceJob, price: wif(300), pitch: "Cheapest." }, "second racer bids");
    await submitPlan(worker, { action: "approve", amount: wif(200).toString() }, "first racer bond approved");
    await submitPlan(rival, { action: "approve", amount: wif(150).toString() }, "second racer bond approved");

    const workerBefore = await balanceOf(worker.account.address);
    const rivalBefore = await balanceOf(rival.account.address);

    const baseNonce = await publicClient.getTransactionCount({ address: employer.account.address });
    const first = encodeFunctionData({ abi: escrowAbi, functionName: "acceptBid", args: [BigInt(raceJob), 0n] });
    const second = encodeFunctionData({ abi: escrowAbi, functionName: "acceptBid", args: [BigInt(raceJob), 1n] });
    const [a, b] = await Promise.allSettled([
      employer.wallet.sendTransaction({ to: ESCROW, data: first, gas: 500_000n, nonce: baseNonce }),
      employer.wallet.sendTransaction({ to: ESCROW, data: second, gas: 500_000n, nonce: baseNonce + 1 }),
    ]);

    let landed = 0;
    for (const settled of [a, b]) {
      if (settled.status === "fulfilled") {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: settled.value });
        if (receipt.status === "success") landed++;
        receipts.push(`race accept ${settled.value} (${receipt.status})`);
      } else {
        console.log(`         -> one leg was refused on arrival: ${errorName(describe(settled.reason))}`);
      }
    }
    check("exactly one accept took effect", landed === 1, `${landed} of 2 landed`);

    const afterRace = await call(client, "pact_get_job", { jobId: raceJob });
    check("the job is ASSIGNED to one worker", afterRace.state === "ASSIGNED", afterRace.state);
    const winnerIsWorker = afterRace.worker?.address?.toLowerCase() === worker.account.address.toLowerCase();
    const winnerIsRival = afterRace.worker?.address?.toLowerCase() === rival.account.address.toLowerCase();
    check("the winner is one of the two bidders", winnerIsWorker || winnerIsRival, JSON.stringify(afterRace.worker));

    const workerAfter = await balanceOf(worker.account.address);
    const rivalAfter = await balanceOf(rival.account.address);
    const pulled = (workerBefore - workerAfter === wif(200) ? 1 : 0) + (rivalBefore - rivalAfter === wif(150) ? 1 : 0);
    check("only one bond was pulled", pulled === 1, `worker ${human(workerBefore - workerAfter)}, rival ${human(rivalBefore - rivalAfter)}`);
    check(
      "the bond pulled matches the winner's price",
      (winnerIsWorker && workerBefore - workerAfter === wif(200)) || (winnerIsRival && rivalBefore - rivalAfter === wif(150)),
      "the winning price and the bonded amount disagree",
    );
  }

  } catch (error) {
    check("every scenario above ran to completion", false, errorName(describe(error)));
  }

  // ---------------------------------------------------------------- release after silence
  console.log("\n-- release after silence");
  const earlyPlan = await call(client, "pact_plan", { action: "release_expired", address: rival.account.address, jobId: clockJob });
  check("the planner refuses release before the window closes", earlyPlan.ok === false, earlyPlan.reason);
  console.log(`         -> ${earlyPlan.reason}`);
  await forceRevert(rival, "releaseExpired", [BigInt(clockJob)], "release before the window closes", "NotYetReleasable");

  const waitSeconds = Math.max(0, Number(autoReleaseAt) + 20 - now());
  console.log(`         -> waiting ${Math.ceil(waitSeconds / 60)} minutes for autoReleaseAt`);
  while (now() < Number(autoReleaseAt) + 20) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const left = Number(autoReleaseAt) + 20 - now();
    if (left > 0) console.log(`            ${Math.ceil(left / 60)} min left`);
  }

  const workerBeforeRelease = await balanceOf(worker.account.address);
  const released = await submitPlan(rival, { action: "release_expired", jobId: clockJob }, "a passer-by releases the silent job");
  check("releaseExpired settles the job without the employer", released?.jobState === "SETTLED", released?.jobState);
  const clockAfter = await call(client, "pact_get_job", { jobId: clockJob });
  check(
    "the silent employer's job pays the worker price minus the cut plus the bond",
    clockAfter.settlement?.creditedToWorker?.wei === wif(1_450).toString(),
    `${clockAfter.settlement?.creditedToWorker?.wif} WIF`,
  );
  check("the employer is credited nothing", clockAfter.settlement?.creditedToEmployer?.wei === "0", JSON.stringify(clockAfter.settlement?.creditedToEmployer));
  await submitPlan(worker, { action: "settle", jobId: clockJob }, "record and claim the auto-release");
  const workerAfterRelease = await balanceOf(worker.account.address);
  check("the worker is paid 1,450 WIF", workerAfterRelease - workerBeforeRelease === wif(1_450), `${human(workerAfterRelease - workerBeforeRelease)} WIF`);

  // ---------------------------------------------------------------- report
  console.log("\n" + "=".repeat(72));
  for (const line of results) console.log(line);
  console.log("=".repeat(72));
  console.log(`${passed} passed, ${failed} failed of ${passed + failed}`);
  if (receipts.length > 0) {
    console.log("\nreceipts");
    for (const line of receipts) console.log("  " + line);
  }
  await client.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nharness failed:", error);
  for (const line of results) console.log(line);
  process.exit(1);
});
