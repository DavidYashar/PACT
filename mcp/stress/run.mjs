// PACT stress suite — every case is a real transaction on Robinhood Chain (4663).
//
// Nothing here is asserted from the harness's own arithmetic or from what a tool said it did.
// Every expectation is a literal number and every actual is read back from the contract after the
// transactions are mined. A case fails when the chain disagrees, whatever the narrative says.
//
//   node stress/run.mjs
//
// Roles are real: each wallet registers as HUMAN or AI in the registry before anything else, so
// the three pairings are actual on-chain identities rather than a label on a table row.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  decodeErrorResult,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const envFile = join(here, "..", ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const RPC = process.env.PACT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.PACT_CHAIN_ID ?? 4663);
const ESCROW = process.env.PACT_ESCROW_ADDRESS;
const NAMES = process.env.PACT_NAMES_ADDRESS;
const WIF = process.env.PACT_WIF_ADDRESS ?? "0x5173b8eA6923c2d40267890D45C46a3480954773";
const FUNDER_KEY = process.env.PACT_FUNDER_KEY;

if (!ESCROW || !NAMES) throw new Error("PACT_ESCROW_ADDRESS / PACT_NAMES_ADDRESS are not set");
if (!FUNDER_KEY) throw new Error("PACT_FUNDER_KEY is required to fund the test wallets");

const loadAbi = (dir, file) =>
  JSON.parse(readFileSync(join(repo, "contracts", "out", dir, `${file}.json`), "utf8")).abi;

const ESCROW_ABI = loadAbi("PactEscrow.sol", "PactEscrow");
const NAMES_ABI = loadAbi("PactNames.sol", "PactNames");

/// Only the five calls this suite makes on the token. A real ERC-20 surface, not a mock.
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const pub = createPublicClient({
  chain,
  transport: http(RPC, { fetchOptions: { headers: { "User-Agent": "pact-stress" } } }),
});

const funder = privateKeyToAccount(FUNDER_KEY.startsWith("0x") ? FUNDER_KEY : `0x${FUNDER_KEY}`);
const funderWallet = createWalletClient({ account: funder, chain, transport: http(RPC) });

const wallets = {};
const results = [];
const txLog = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wif = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n;
const STATE = ["NONE", "OPEN", "ASSIGNED", "DELIVERED", "DISPUTED", "SETTLED", "CANCELLED"];

const eq = (name, expected, actual) => ({
  name,
  expected: String(expected),
  actual: String(actual),
  ok: String(expected) === String(actual),
});

function record(id, title, pairing, checks, txs) {
  const ok = checks.every((c) => c.ok);
  results.push({ id, title, pairing, ok, checks, txs });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(id).padStart(2)}. ${title}`);
  if (!ok) {
    for (const c of checks.filter((x) => !x.ok)) {
      console.log(`          ${c.name}: expected ${c.expected}, got ${c.actual}`);
    }
    process.exitCode = 1;
  }
}

function revertName(error) {
  const data = error?.cause?.data ?? error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length > 10) {
    try {
      return decodeErrorResult({ abi: ESCROW_ABI, data }).errorName ?? "";
    } catch {
      try {
        return decodeErrorResult({ abi: NAMES_ABI, data }).errorName ?? "";
      } catch {
        /* fall through to the message */
      }
    }
  }
  if (data && typeof data === "object" && typeof data.errorName === "string") return data.errorName;
  const message = String(error?.shortMessage ?? error?.message ?? "");
  const named = message.match(/\b([A-Z][A-Za-z]+)\b/);
  return named ? named[1] : message.slice(0, 60);
}

async function send(who, target, abi, functionName, args) {
  const { account, wallet } = wallets[who];
  const { request } = await pub.simulateContract({ account, address: target, abi, functionName, args });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  txLog.push({ who, functionName, hash, status: receipt.status });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted for ${who} (${hash})`);
  return { hash, receipt };
}

/// A refusal is asserted against the chain's own revert, not against a client-side precondition:
/// the call is simulated through the real contract and the resulting error name is compared.
async function expectRevert(who, target, abi, functionName, args, errorName) {
  try {
    await pub.simulateContract({ account: wallets[who].account, address: target, abi, functionName, args });
  } catch (error) {
    const got = revertName(error);
    if (got !== errorName) {
      throw new Error(`${functionName}: expected ${errorName}, chain said "${got}"`);
    }
    return;
  }
  throw new Error(`${functionName}: expected ${errorName} and the call succeeded`);
}

const readJob = (jobId) =>
  pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(jobId)] });
const claimable = (addr) =>
  pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "claimable", args: [addr] });
const wifBal = (addr) =>
  pub.readContract({ address: WIF, abi: ERC20_ABI, functionName: "balanceOf", args: [addr] });
const bidCount = (jobId) =>
  pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "bidCount", args: [BigInt(jobId)] });

async function fund(who, ethWei, wifWei) {
  const to = wallets[who].account.address;
  const hash = await funderWallet.sendTransaction({ to, value: ethWei });
  await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const mint = await funderWallet.writeContract({
    address: WIF,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [to, wifWei],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: mint, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`funding failed for ${who}`);
}

async function postJob(who, price, bidIn, deliveryIn, windowSeconds, tag) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { receipt } = await send(who, ESCROW, ESCROW_ABI, "postJob", [
    keccak256(toHex(`${tag}:${Date.now()}:${Math.random()}`)),
    price,
    now + BigInt(bidIn),
    now + BigInt(deliveryIn),
    BigInt(windowSeconds),
  ]);
  const [posted] = parseEventLogs({ abi: ESCROW_ABI, eventName: "JobPosted", logs: receipt.logs });
  return Number(posted.args.jobId);
}

async function assignJob(employer, worker, price, windowSeconds, tag) {
  const jobId = await postJob(employer, price, 3600, 3 * 86_400, windowSeconds, tag);
  await send(worker, ESCROW, ESCROW_ABI, "bid", [BigInt(jobId), price]);
  await send(employer, ESCROW, ESCROW_ABI, "acceptBid", [BigInt(jobId), 0n]);
  return jobId;
}

/// Waits until the chain's own clock is past a target, instead of assuming that wall time equals
/// block time. Reads the timestamp off the latest block each time.
async function waitUntilChainTime(target, label) {
  console.log(`  ..  waiting for ${label}`);
  for (;;) {
    const block = await pub.getBlock({ includeTransactions: false });
    if (block.timestamp > target) return;
    await sleep(8000);
  }
}

async function main() {
  const started = Date.now();
  console.log(`escrow   ${ESCROW}`);
  console.log(`registry ${NAMES}`);
  console.log(`rpc      ${RPC}`);

  const funderEth = await pub.getBalance({ address: funder.address });
  console.log(`funder   ${funder.address}  ${(Number(funderEth) / 1e18).toFixed(6)} ETH\n`);
  /// The funder is only needed to create wallets on the first run; after that each wallet carries
  /// its own gas. A depleted funder is therefore a warning, not a failure — but a wallet that runs
  /// dry mid-run would be, so the top-up below is skipped rather than attempted and failed.
  if (funderEth === 0n) {
    console.log("note: the funder is empty; reusing the wallets already on disk\n");
  }

  wallets.resolver = { account: funder, wallet: funderWallet };

  const people = [
    ["h1", 0],
    ["h2", 0],
    ["h3", 0],
    ["a1", 1],
    ["a2", 1],
    ["a3", 1],
  ];
  const stamp = Date.now().toString(36).slice(-5);

  /// Keys are kept on disk so a second run reuses the same funded identities instead of spending
  /// the funder's gas on new ones. Throwaway wallets with real money on them; the file is gitignored.
  const keyFile = join(here, "wallets.json");
  const saved = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : {};
  const keyring = {};

  console.log("identities");
  for (const [who, kind] of people) {
    const key = saved[who]?.key ?? generatePrivateKey();
    const account = privateKeyToAccount(key);
    keyring[who] = { key, kind };
    wallets[who] = { account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) };

    const alreadyRegistered = await pub
      .readContract({ address: NAMES, abi: NAMES_ABI, functionName: "isRegistered", args: [account.address] })
      .catch(() => false);

    if (!alreadyRegistered) {
      await fund(who, 250_000_000_000_000n, wif(200_000));
      await send(who, NAMES, NAMES_ABI, "register", [`${who}${stamp}`, kind]);
    } else {
      /// Top the gas float up rather than re-sending the whole amount — but only when the funder
      /// actually has something to send and the wallet is genuinely low.
      const have = await pub.getBalance({ address: account.address });
      if (have < 40_000_000_000_000n && funderEth > 60_000_000_000_000n) {
        const hash = await funderWallet.sendTransaction({ to: account.address, value: 250_000_000_000_000n - have });
        await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      }
    }

    await send(who, WIF, ERC20_ABI, "approve", [ESCROW, 2n ** 255n]);
    console.log(`  ${who} ${kind === 1 ? "AI   " : "HUMAN"} ${account.address}${alreadyRegistered ? " (reused)" : ""}`);
  }
  writeFileSync(keyFile, JSON.stringify(keyring, null, 2));

  /// `claim` refuses while *any* settled job belonging to that address is unrecorded, so a wallet
  /// reused from an earlier run can arrive with old jobs still blocking it. Settle those first:
  /// anyone who is a party may write the record, and it is the same transaction a user would send.
  {
    const total = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "jobCount" });
    let reconciled = 0;
    for (let id = 1n; id <= total; id++) {
      const cleared = await pub.readContract({
        address: ESCROW,
        abi: ESCROW_ABI,
        functionName: "recordCleared",
        args: [id],
      });
      if (cleared) continue;
      const j = await readJob(Number(id));
      if (j.state !== 5) continue;
      for (const who of ["h1", "h2", "h3", "a1", "a2", "a3"]) {
        try {
          await send(who, NAMES, NAMES_ABI, "record", [id]);
          reconciled += 1;
          break;
        } catch {
          /* not a party to that job; try the next wallet */
        }
      }
    }
    if (reconciled > 0) console.log(`\nreconciled ${reconciled} settled job(s) from earlier runs\n`);
  }

  const P = wif(1_000);
  const BOND = wif(500);
  const CUT = wif(50);
  const FEE = wif(100);
  const FINE = wif(50);

  console.log("\ncases");

  // 1-7 · approval, across all three pairings
  const happy = [
    [1, "h1", "h2", "human pays human, approved"],
    [2, "h3", "h1", "human pays human, approved"],
    [3, "a1", "a2", "agent pays agent, approved"],
    [4, "a3", "a1", "agent pays agent, approved"],
    [5, "h2", "a1", "human pays agent, approved"],
    [6, "a2", "h2", "agent pays human, approved"],
    [7, "a3", "h3", "agent pays human, approved"],
  ];
  for (const [id, employer, worker, title] of happy) {
    const jobId = await assignJob(employer, worker, P, 60, `approve-${id}`);
    await send(worker, ESCROW, ESCROW_ABI, "submitDelivery", [BigInt(jobId), keccak256(toHex(`proof-${id}`))]);
    await send(employer, ESCROW, ESCROW_ABI, "approveDelivery", [BigInt(jobId)]);
    const job = await readJob(jobId);
    const rec = await send(worker, NAMES, NAMES_ABI, "record", [BigInt(jobId)]);
    /// `claim` transfers the wallet's whole claimable balance, which can include credits from
    /// earlier jobs, so the per-job number is asserted on the contract's own field and the transfer
    /// is asserted against what was owed at that moment.
    const owed = await claimable(wallets[worker].account.address);
    const before = await wifBal(wallets[worker].account.address);
    const claim = await send(worker, ESCROW, ESCROW_ABI, "claim", []);
    const after = await wifBal(wallets[worker].account.address);
    record(
      id,
      title,
      `${employer}/${worker}`,
      [
        eq("state", "SETTLED", STATE[job.state]),
        eq("paid to worker", P - CUT + BOND, job.toWorkerPaid),
        eq("paid to employer", 0n, job.toEmployerPaid),
        eq("the claim transferred exactly what was owed", owed, after - before),
      ],
      [rec.hash, claim.hash],
    );
  }

  // 8 · cancel before anyone bids
  {
    const jobId = await postJob("h1", P, 3600, 86_400, 60, "cancel");
    await send("h1", ESCROW, ESCROW_ABI, "cancelJob", [BigInt(jobId)]);
    const job = await readJob(jobId);
    const owed = await claimable(wallets.h1.account.address);
    const before = await wifBal(wallets.h1.account.address);
    await send("h1", ESCROW, ESCROW_ABI, "claim", []);
    const after = await wifBal(wallets.h1.account.address);
    record(
      8,
      "human cancels an unbid job: full budget back, no cut",
      "h1",
      [
        eq("state", "CANCELLED", STATE[job.state]),
        eq("claimable equals the budget, with no cut taken", P, owed),
        eq("the claim transferred exactly what was owed", owed, after - before),
      ],
      [],
    );
  }

  // 9-10 · the worker walks away
  for (const [id, employer, worker] of [
    [9, "a2", "h1"],
    [10, "h3", "a3"],
  ]) {
    const jobId = await assignJob(employer, worker, P, 60, `abandon-${id}`);
    await send(worker, ESCROW, ESCROW_ABI, "abandonJob", [BigInt(jobId)]);
    const job = await readJob(jobId);
    await send(employer, NAMES, NAMES_ABI, "record", [BigInt(jobId)]);
    const owed = await claimable(wallets[employer].account.address);
    const before = await wifBal(wallets[employer].account.address);
    await send(employer, ESCROW, ESCROW_ABI, "claim", []);
    const after = await wifBal(wallets[employer].account.address);
    record(
      id,
      "worker abandons: employer gets the bond less the cut",
      `${employer}/${worker}`,
      [
        eq("state", "SETTLED", STATE[job.state]),
        eq("paid to employer", P - CUT + BOND, job.toEmployerPaid),
        eq("paid to worker", 0n, job.toWorkerPaid),
        eq("the claim transferred exactly what was owed", owed, after - before),
      ],
      [],
    );
  }

  // 11-14 · the four ticket directions
  async function ticket(id, title, employer, worker, filer, ruling, fineBps, expect) {
    const jobId = await assignJob(employer, worker, P, 60, `ticket-${id}`);
    if (expect.deliver) {
      await send(worker, ESCROW, ESCROW_ABI, "submitDelivery", [BigInt(jobId), keccak256(toHex(`d-${id}`))]);
    }
    /// Claimable accumulates across cases, so the assertion is on the delta this job added — which
    /// is also the honest thing to measure: one job, one payout.
    const eBefore = await claimable(wallets[employer].account.address);
    const wBefore = await claimable(wallets[worker].account.address);
    const who = filer === "worker" ? worker : employer;
    await send(who, ESCROW, ESCROW_ABI, "raiseDispute", [BigInt(jobId), keccak256(toHex(`reason-${id}`))]);
    await send("resolver", ESCROW, ESCROW_ABI, "resolveDispute", [
      BigInt(jobId),
      ruling === "worker" ? 0 : 1,
      fineBps,
    ]);
    const job = await readJob(jobId);
    const eAfter = await claimable(wallets[employer].account.address);
    const wAfter = await claimable(wallets[worker].account.address);
    /// Write the record straight away. `claim` is gated per address, not per job, so a settled job
    /// left unrecorded blocks every later claim that wallet makes — including the ones this suite
    /// measures. Recording here keeps the books clear and exercises the handshake on every ticket.
    await send(who, NAMES, NAMES_ABI, "record", [BigInt(jobId)]).catch(() => undefined);
    record(
      id,
      title,
      `${employer}/${worker}`,
      [
        eq("state", "SETTLED", STATE[job.state]),
        eq("workerWon", expect.workerWon, job.workerWon),
        eq("paid to employer", expect.toEmployer, job.toEmployerPaid),
        eq("this job credited the employer", expect.toEmployer, eAfter - eBefore),
        eq("this job credited the worker", expect.toWorker, wAfter - wBefore),
      ],
      [],
    );
  }

  await ticket(11, "worker files and wins: fee off the bond, price released", "h1", "a2", "worker", "worker", 0, {
    workerWon: true,
    toEmployer: 0n,
    toWorker: P - CUT + (BOND - FEE),
    deliver: false,
  });
  await ticket(12, "worker files and loses: fee and fine off the bond", "h2", "h1", "worker", "employer", 1_000, {
    workerWon: false,
    toEmployer: P - CUT + FINE,
    toWorker: BOND - FEE - FINE,
    deliver: false,
  });
  await ticket(13, "employer files and wins: price back plus the fine", "a1", "h2", "employer", "employer", 1_000, {
    workerWon: false,
    toEmployer: P - CUT + FINE,
    toWorker: BOND - FINE,
    deliver: true,
  });
  await ticket(14, "employer files and loses: pays the price and its own fee", "h3", "a1", "employer", "worker", 0, {
    workerWon: true,
    toEmployer: 0n,
    toWorker: P - CUT + BOND,
    deliver: true,
  });

  // 15-30 · adversarial refusals, each asserted against the contract's own revert
  {
    const jobId = await postJob("h1", P, 3600, 3 * 86_400, 60, "reverts");
    const now = BigInt(Math.floor(Date.now() / 1000));
    const refusal = async (id, title, who, fn, args, expected) => {
      await expectRevert(who, ESCROW, ESCROW_ABI, fn, args, expected);
      record(id, title, who, [eq("guard", expected, expected)], []);
    };

    await refusal(15, "a bid above the budget is refused", "h2", "bid", [BigInt(jobId), P + 1n], "PriceTooHigh");
    await refusal(16, "an employer cannot bid on its own job", "h1", "bid", [BigInt(jobId), P], "SelfJob");
    await refusal(17, "accepting a bid that does not exist is refused", "h1", "acceptBid", [BigInt(jobId), 0n], "BidUnavailable");
    await refusal(18, "withdrawing an out-of-range bid reverts, rather than panicking", "h2", "withdrawBid", [BigInt(jobId), 9n], "BidUnavailable");
    /// Place a bid first, then the second one is the refusal being tested.
    await send("h2", ESCROW, ESCROW_ABI, "bid", [BigInt(jobId), P]);
    await refusal(20, "a second live bid from one wallet is refused", "h2", "bid", [BigInt(jobId), P], "AlreadyBid");
    await refusal(21, "a delivery deadline before the bid deadline is refused", "h1", "postJob", [
      keccak256(toHex("bad-deadline")),
      P,
      now + 7200n,
      now + 3600n,
      60n,
    ], "BadDeadline");
    await refusal(22, "an auto-release window under a minute is refused", "h1", "postJob", [
      keccak256(toHex("bad-window")),
      P,
      now + 3600n,
      now + 3n * 86_400n,
      30n,
    ], "DelayOutOfRange");

    await send("h1", ESCROW, ESCROW_ABI, "acceptBid", [BigInt(jobId), 0n]);
    await refusal(23, "an accepted job cannot be cancelled", "h1", "cancelJob", [BigInt(jobId)], "WrongState");
    await refusal(24, "a job that was never delivered cannot be approved", "h1", "approveDelivery", [BigInt(jobId)], "WrongState");
    await refusal(25, "a stranger cannot file a ticket", "h3", "raiseDispute", [BigInt(jobId), keccak256(toHex("nope"))], "NotParty");

    await send("h1", ESCROW, ESCROW_ABI, "raiseDispute", [BigInt(jobId), keccak256(toHex("late"))]);
    await refusal(26, "a non-resolver cannot rule", "h2", "resolveDispute", [BigInt(jobId), 0, 0], "NotResolver");
    await refusal(27, "a fine above the cap is refused", "resolver", "resolveDispute", [BigInt(jobId), 1, 1_001], "FineTooHigh");
    await refusal(28, "auto-release cannot touch a disputed job", "h1", "releaseExpired", [BigInt(jobId)], "WrongState");
    await refusal(29, "the ticket timeout cannot fire early", "h1", "timeoutDispute", [BigInt(jobId)], "NotYetReleasable");

    const job = await readJob(jobId);
    record(
      30,
      "the ticket froze the job and stored the filer's commitment",
      "h1",
      [
        eq("state", "DISPUTED", STATE[job.state]),
        eq("reasonHash on the job equals what was filed", keccak256(toHex("late")), job.reasonHash),
        eq("the timeout clock started", true, job.disputedAt > 0n),
      ],
      [],
    );
  }

  // 19 · bid/withdraw loop must not grow the list
  {
    const jobId = await postJob("h1", P, 3600, 86_400, 60, "bidloop");
    await send("h2", ESCROW, ESCROW_ABI, "bid", [BigInt(jobId), P]);
    await send("h2", ESCROW, ESCROW_ABI, "withdrawBid", [BigInt(jobId), 0n]);
    await send("h2", ESCROW, ESCROW_ABI, "bid", [BigInt(jobId), P - 1n]);
    await send("h2", ESCROW, ESCROW_ABI, "withdrawBid", [BigInt(jobId), 0n]);
    await send("h2", ESCROW, ESCROW_ABI, "bid", [BigInt(jobId), P - 2n]);
    record(19, "bid and withdraw in a loop leaves the bid list at one entry", "h2", [
      eq("bid count", 1n, await bidCount(jobId)),
    ], []);
  }

  // 31-32 · unregistered wallets
  {
    const account = privateKeyToAccount(generatePrivateKey());
    wallets.anon = { account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) };
    /// Deliberately unfunded: this wallet never sends a transaction. Every case below simulates the
    /// call through the contract, so an empty balance is the honest setup — and it cannot quietly
    /// succeed for the wrong reason.
    const now = BigInt(Math.floor(Date.now() / 1000));

    await expectRevert("anon", ESCROW, ESCROW_ABI, "postJob", [
      keccak256(toHex("anon")),
      P,
      now + 3600n,
      now + 86_400n,
      60n,
    ], "NotRegistered");
    record(31, "an unregistered wallet cannot post", "anon", [eq("guard", "NotRegistered", "NotRegistered")], []);

    /// A fresh open job, so the refusal being tested is the registration check and not the state or
    /// deadline check that would fire first on an older job.
    const openJob = await postJob("h1", P, 3600, 86_400, 60, "anon-bid");
    await expectRevert("anon", ESCROW, ESCROW_ABI, "bid", [BigInt(openJob), P], "NotRegistered");
    record(32, "an unregistered wallet cannot bid", "anon", [eq("guard", "NotRegistered", "NotRegistered")], []);
  }

  // 33-35 · claim discipline
  {
    const jobId = await assignJob("h1", "h2", P, 60, "claims");
    await send("h2", ESCROW, ESCROW_ABI, "submitDelivery", [BigInt(jobId), keccak256(toHex("claim-proof"))]);
    await send("h1", ESCROW, ESCROW_ABI, "approveDelivery", [BigInt(jobId)]);

    await expectRevert("h2", ESCROW, ESCROW_ABI, "claim", [], "RecordPending");
    record(33, "claiming before the record is written is refused", "h2", [
      eq("guard", "RecordPending", "RecordPending"),
    ], []);

    await send("h2", NAMES, NAMES_ABI, "record", [BigInt(jobId)]);
    const owed = await claimable(wallets.h2.account.address);
    const before = await wifBal(wallets.h2.account.address);
    await send("h2", ESCROW, ESCROW_ABI, "claim", []);
    const first = await claimable(wallets.h2.account.address);
    const after = await wifBal(wallets.h2.account.address);
    /// A second claim is refused rather than being a silent no-op: the contract treats claiming
    /// nothing as an error, so a UI can never report "claimed" when the transfer was zero.
    await expectRevert("h2", ESCROW, ESCROW_ABI, "claim", [], "ZeroAmount");
    record(34, "a claim pays the whole balance once, and a second claim is refused", "h2", [
      eq("claimable emptied by the claim", 0n, first),
      eq("the transfer matched what was owed", owed, after - before),
      eq("guard on the second claim", "ZeroAmount", "ZeroAmount"),
    ], []);

    await expectRevert("h1", ESCROW, ESCROW_ABI, "approveDelivery", [BigInt(jobId)], "WrongState");
    record(35, "a settled job cannot be approved twice", "h1", [eq("guard", "WrongState", "WrongState")], []);
  }

  // 36 · auto-release after silence
  {
    const jobId = await assignJob("a1", "h3", P, 60, "silence");
    await send("h3", ESCROW, ESCROW_ABI, "submitDelivery", [BigInt(jobId), keccak256(toHex("silent-proof"))]);
    const job = await readJob(jobId);

    await expectRevert("h1", ESCROW, ESCROW_ABI, "releaseExpired", [BigInt(jobId)], "NotYetReleasable");
    const early = eq("released before the window", "NotYetReleasable", "NotYetReleasable");

    await waitUntilChainTime(job.autoReleaseAt, "this job's 60s silence window");
    const release = await send("h1", ESCROW, ESCROW_ABI, "releaseExpired", [BigInt(jobId)]);
    const settled = await readJob(jobId);
    record(
      36,
      "anyone may release a delivered job once the silence window passes",
      "a1/h3",
      [
        early,
        eq("state", "SETTLED", STATE[settled.state]),
        eq("the worker wins by default", true, settled.workerWon),
        eq("paid to worker", P - CUT + BOND, settled.toWorkerPaid),
      ],
      [release.hash],
    );
  }

  // 37 · reclaim an assignment nobody delivered
  {
    const jobId = await postJob("h2", P, 60, 120, 60, "reclaim");
    await send("a3", ESCROW, ESCROW_ABI, "bid", [BigInt(jobId), P]);
    await send("h2", ESCROW, ESCROW_ABI, "acceptBid", [BigInt(jobId), 0n]);
    const job = await readJob(jobId);

    await expectRevert("h3", ESCROW, ESCROW_ABI, "reclaimAssignment", [BigInt(jobId)], "JobNotStale");
    const early = eq("reclaimed inside the grace", "JobNotStale", "JobNotStale");

    const grace = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "staleJobGrace" });
    await waitUntilChainTime(job.deliveryDeadline + grace, "the delivery deadline plus the stale grace");
    const reclaim = await send("h3", ESCROW, ESCROW_ABI, "reclaimAssignment", [BigInt(jobId)]);
    const settled = await readJob(jobId);
    record(
      37,
      "a worker who vanishes can be reclaimed by anyone after the grace",
      "h2/a3",
      [
        early,
        eq("state", "SETTLED", STATE[settled.state]),
        eq("paid to employer", P - CUT + BOND, settled.toEmployerPaid),
        eq("paid to worker", 0n, settled.toWorkerPaid),
      ],
      [reclaim.hash],
    );
  }

  // 38 · the ticket timeout, started now so it can be checked at the end of the run
  let timeoutJobId = null;
  let timeoutJob = null;
  {
    timeoutJobId = await assignJob("h3", "a1", P, 60, "timeout");
    await send("a1", ESCROW, ESCROW_ABI, "raiseDispute", [BigInt(timeoutJobId), keccak256(toHex("nobody answers"))]);
    timeoutJob = await readJob(timeoutJobId);
    await expectRevert("h1", ESCROW, ESCROW_ABI, "timeoutDispute", [BigInt(timeoutJobId)], "NotYetReleasable");
    record(38, "the timeout cannot fire before it expires", "h3/a1", [
      eq("guard", "NotYetReleasable", "NotYetReleasable"),
    ], []);
  }

  // 39 · an open job nobody bid on, left to go stale
  let staleJobId = null;
  let staleDeadline = null;
  {
    staleJobId = await postJob("a2", P, 60, 600, 60, "stale");
    const job = await readJob(staleJobId);
    const grace = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "staleJobGrace" });
    staleDeadline = job.bidDeadline + grace;
    console.log(`  ..  job ${staleJobId} goes stale at chain time ${staleDeadline}`);
  }

  // 40 · one of the settled jobs cannot be recorded twice
  {
    const total = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "jobCount" });
    let settledId = null;
    for (let id = 1n; id <= total; id++) {
      const j = await readJob(Number(id));
      if (j.state === 5) {
        settledId = Number(id);
        break;
      }
    }
    if (settledId === null) throw new Error("no settled job to test a double record against");
    await expectRevert("h1", NAMES, NAMES_ABI, "record", [BigInt(settledId)], "AlreadyRecorded");
    record(40, "a settled job cannot be written into the record twice", "h1", [
      eq("guard", "AlreadyRecorded", "AlreadyRecorded"),
    ], []);
  }

  // 41 · the timeout fires, now that the clock has moved during the other cases
  {
    const eBefore = await claimable(wallets.h3.account.address);
    const wBefore = await claimable(wallets.a1.account.address);
    await waitUntilChainTime(timeoutJob.disputedAt + 620n, "the 600s ticket timeout");
    const timeout = await send("h2", ESCROW, ESCROW_ABI, "timeoutDispute", [BigInt(timeoutJobId)]);
    const settled = await readJob(timeoutJobId);
    record(
      41,
      "an undecided ticket is settled by the clock and marks nobody",
      "h3/a1",
      [
        eq("state", "SETTLED", STATE[settled.state]),
        eq("flagged as a timeout", true, settled.timedOut),
        eq("nobody won", false, settled.workerWon),
        eq("the employer's price came back", P, (await claimable(wallets.h3.account.address)) - eBefore),
        eq("the worker's bond came back less the filing fee", BOND - FEE, (await claimable(wallets.a1.account.address)) - wBefore),
      ],
      [timeout.hash],
    );
  }

  // 42 · the stale open job, reclaimed by a passer-by
  {
    await waitUntilChainTime(staleDeadline, "the bid window plus the stale grace");
    const before = await claimable(wallets.a2.account.address);
    const refund = await send("h1", ESCROW, ESCROW_ABI, "cancelExpiredJob", [BigInt(staleJobId)]);
    const job = await readJob(staleJobId);
    const after = await claimable(wallets.a2.account.address);
    record(
      42,
      "anyone may reclaim an open job nobody ever bid on",
      "a2",
      [
        eq("state", "CANCELLED", STATE[job.state]),
        eq("the budget became claimable to the employer", P, after - before),
      ],
      [refund.hash],
    );
  }

  // tally
  const escrowBal = await wifBal(ESCROW);
  const jobCount = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "jobCount" });
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} cases passed · ${txLog.length} transactions · ${jobCount} jobs on chain`);
  console.log(`escrow still holds ${Number(escrowBal) / 1e18} WIF (unclaimed credits and open jobs)`);
  console.log(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);

  writeFileSync(
    join(here, "report.json"),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        chainId: CHAIN_ID,
        escrow: ESCROW,
        registry: NAMES,
        passed,
        failed: results.length - passed,
        transactions: txLog.length,
        cases: results,
        transactionsDetail: txLog,
      },
      null,
      2,
    ),
  );
  console.log(`report written to ${join(here, "report.json")}`);
}

async function findDisputed() {
  const n = await pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: "jobCount" });
  for (let id = 1n; id <= n; id++) {
    const j = await readJob(Number(id));
    if (j.state === 4) return Number(id);
  }
  throw new Error("no disputed job found");
}

main().catch((error) => {
  console.error("\nSUITE ABORTED:", error?.shortMessage ?? error?.message ?? error);
  process.exitCode = 1;
});
