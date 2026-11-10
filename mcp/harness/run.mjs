// Live end-to-end proof of the PACT MCP server.
//
// Speaks the real protocol through the official MCP client, signs with a real wallet, and runs
// against the deployed contracts on Robinhood Chain mainnet. The server holds no key at any
// point — every signature below is produced here, in the harness, exactly as an agent would.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWalletClient, createPublicClient, http, formatEther, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { db } from "../dist/db.js";

const MCP_URL = process.env.PACT_MCP_URL ?? "http://localhost:8787/mcp";
const RPC_URL = process.env.PACT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const FUNDER_KEY = process.env.PACT_FUNDER_KEY;
const CHAIN_ID = Number(process.env.PACT_CHAIN_ID ?? 4663);

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

// Exactly the fields an unsigned instruction needs. Anything else in a step (a signature, a raw
// transaction, a `from`) would mean the server produced something only a key holder could produce.
const STEP_FIELDS = [
  "chainId",
  "data",
  "gas",
  "label",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "nonce",
  "to",
  "value",
];

const namesAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      {
        name: "kind",
        type: "uint8",
      },
    ],
    outputs: [],
  },
];

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

function text(result) {
  const first = result?.content?.[0];
  if (!first || first.type !== "text") throw new Error("no text content in tool result");
  if (result.isError) throw new Error(`tool failed: ${first.text}`);
  return JSON.parse(first.text);
}

async function call(client, name, args) {
  return text(await client.callTool({ name, arguments: args }));
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

async function main() {
  // A dedicated wallet, funded with gas only. This is the agent's identity.
  const key = process.env.PACT_TEST_KEY ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

  console.log(`harness wallet ${account.address}`);

  /// A run needs four fresh wallets, so the funder has to hold a little gas. At ~0.012 gwei a
  /// registration costs about 1.4e-9 ETH, so this is thousands of transactions, not a treasury.
  const GAS_PER_AGENT = 50_000_000_000_000n;
  async function fundGas(target) {
    if (!FUNDER_KEY) return;
    const funder = privateKeyToAccount(FUNDER_KEY);
    const funderWallet = createWalletClient({ account: funder, chain, transport: http(RPC_URL) });
    let held = 0n;
    try {
      held = await publicClient.getBalance({ address: funder.address });
    } catch {
      held = 0n;
    }
    if (held < GAS_PER_AGENT) {
      throw new Error(
        `the funder ${funder.address} holds ${formatEther(held)} ETH and needs at least ` +
          `${formatEther(GAS_PER_AGENT)} ETH per wallet to send gas. Top it up, or pass PACT_FUNDER_KEY for a funded key.`,
      );
    }
    const hash = await funderWallet.sendTransaction({ to: target, value: GAS_PER_AGENT });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`         -> gas for ${target} via ${hash}`);
  }

  let balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) await fundGas(account.address);
  balance = await publicClient.getBalance({ address: account.address });
  console.log(`gas balance ${formatEther(balance)} ETH\n`);

  // WIF is the working capital an agent needs to bond with. The test token mints openly, so
  // the harness tops itself up the way an owner would after funding their agent.
  const WIF = process.env.PACT_WIF_ADDRESS ?? "0x5173b8eA6923c2d40267890D45C46a3480954773";
  const wifAbi = [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      type: "function",
      name: "mint",
      stateMutability: "nonpayable",
      inputs: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [],
    },
  ];
  const held = await publicClient.readContract({
    address: WIF,
    abi: wifAbi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (held === 0n) {
    const mintHash = await wallet.writeContract({
      address: WIF,
      abi: wifAbi,
      functionName: "mint",
      args: [account.address, 1_000n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    console.log(`minted 1,000 test WIF via ${mintHash}\n`);
  }

  const client = new Client({ name: "pact-harness", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  console.log("connected to the MCP server\n");

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  /// The surface is pinned on purpose: adding a tool should be a deliberate act, and this is where
  /// the decision gets recorded. 11 since `pact_find_talent` (the boards and search) landed.
  check("tools/list returns the surface", names.length === 11, names.join(","));
  check(
    "no tool can sign or transfer",
    !names.some((n) => /sign|transfer|send|withdraw/i.test(n)),
    names.join(","),
  );
  console.log(`  tools: ${names.join(", ")}\n`);

  // ---- reads ----
  let me = await call(client, "pact_whoami", { address: account.address });
  check("whoami: new wallet is not registered", me.registered === false);
  check("whoami: reports the chain", me.chainId === CHAIN_ID);
  check("whoami: nothing blocking a claim", me.claimBlocked === false);

  const jobs = await call(client, "pact_list_jobs", { limit: 5 });
  check("list_jobs answers", typeof jobs.total === "number");
  console.log(`  jobs on chain: ${jobs.total}\n`);

  // ---- plan + sign + submit: register ----
  const username = `agent${Math.floor(Math.random() * 1e6)}`;
  const regPlan = await call(client, "pact_plan", {
    action: "register",
    address: account.address,
    name: username,
    kind: 1,
  });
  check("plan register succeeds", regPlan.ok === true, regPlan.reason);
  // The plan must be an instruction, not a transaction: this server holds no key, so a step must
  // carry calldata the agent could have built itself and nothing signature-shaped.
  const stepKeys = Object.keys(regPlan.steps?.[0] ?? {}).sort();
  check(
    "plan carries no signed transaction",
    JSON.stringify(stepKeys) === JSON.stringify(STEP_FIELDS) &&
      !JSON.stringify(regPlan).match(/"(signed|raw|rawTransaction|serialized|signature|from)"/i),
    `step fields: ${stepKeys.join(",")}`,
  );
  const expectedCalldata = encodeFunctionData({ abi: namesAbi, functionName: "register", args: [username, 1] });
  check(
    "plan calldata is reproducible by the agent",
    regPlan.steps?.[0]?.data === expectedCalldata,
    regPlan.steps?.[0]?.data,
  );

  const regSigned = await signSteps(wallet, regPlan.steps);
  const regDone = await call(client, "pact_submit", { intentId: regPlan.intentId, signed: regSigned });
  check("submit register lands", regDone.ok === true, regDone.reason);
  for (const r of regDone.receipts ?? []) console.log(`         -> ${r.step}: ${r.hash} (block ${r.blockNumber}, ${r.status})`);

  me = await call(client, "pact_whoami", { address: account.address });
  check("whoami: now registered", me.registered === true);
  check("whoami: username recorded", me.username === username, me.username);
  check("whoami: kind is AI", me.kind === "AI", me.kind);
  console.log(`  registered as @${me.username}\n`);

  const profile = await call(client, "pact_get_profile", { address: account.address });
  check("get_profile: username present", profile.username === username);

  // ---- negative: replaying a consumed intent must be refused ----
  const replay = await call(client, "pact_submit", { intentId: regPlan.intentId, signed: regSigned });
  check("replayed intent is refused", replay.ok === false, replay.reason);
  console.log(`         -> ${replay.reason}`);

  // ---- a second, independent agent posts a job, so the bid path is always exercised ----
  // Nothing about this agent is shared with the first one: separate key, separate gas, separate
  // WIF, separate username. It only exists so the first agent has real work to bid on.
  async function spawnAgent(prefix, options = { register: true }) {
    const agentAccount = privateKeyToAccount(generatePrivateKey());
    const agentWallet = createWalletClient({ account: agentAccount, chain, transport: http(RPC_URL) });
    await fundGas(agentAccount.address);
    const mintHash = await agentWallet.writeContract({
      address: WIF,
      abi: wifAbi,
      functionName: "mint",
      args: [agentAccount.address, 500n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    const agentName = `${prefix}${Math.floor(Math.random() * 1e6)}`;
    if (!options.register) return { account: agentAccount, wallet: agentWallet, name: null };
    const theirReg = await call(client, "pact_plan", {
      action: "register",
      address: agentAccount.address,
      name: agentName,
      kind: 1,
    });
    const theirDone = await call(client, "pact_submit", {
      intentId: theirReg.intentId,
      signed: await signSteps(agentWallet, theirReg.steps),
    });
    check(`second agent @${agentName} is registered`, theirDone.ok === true, theirDone.reason);
    return { account: agentAccount, wallet: agentWallet, name: agentName };
  }

  const rival = await spawnAgent("rival");
  const openTerms = {
    title: "Bring 1,000 engaged followers to a new account",
    description: "Steady growth, real accounts, no bots. Report weekly.",
    criteria: "Follower count above 1,000 on the deadline date, and no more than 10% drop in 7 days.",
    proofSpec: "Link to the account plus dated screenshots for the first and last day.",
    category: "social",
  };
  const nowForRival = Math.floor(Date.now() / 1000);
  const rivalPlan = await call(client, "pact_plan", {
    action: "post_job",
    address: rival.account.address,
    terms: openTerms,
    budget: "100000000000000000000",
    bidDeadline: nowForRival + 3600,
    deliveryDeadline: nowForRival + 86_400,
  });
  const rivalPosted = await call(client, "pact_submit", {
    intentId: rivalPlan.intentId,
    signed: await signSteps(rival.wallet, rivalPlan.steps),
  });
  check("second agent posts a job others can bid on", rivalPosted.ok === true, rivalPosted.reason);
  const openJobId = rivalPosted.jobId;
  console.log(`         -> @${rival.name} posted job ${openJobId} with ${openTerms.title}\n`);

  // ---- negative: a bid signed by a different wallet ----
  if (openJobId) {
    const bidPlan = await call(client, "pact_plan", {
      action: "bid",
      address: account.address,
      jobId: openJobId,
      price: "100000000000000000000",
      pitch: "I can do this in two days. Same stack, mobile first, and I will hand over the source.",
    });

    if (bidPlan.ok) {
      const other = privateKeyToAccount(generatePrivateKey());
      const otherWallet = createWalletClient({ account: other, chain, transport: http(RPC_URL) });
      const wrongSigned = await signSteps(otherWallet, bidPlan.steps);
      const wrong = await call(client, "pact_submit", { intentId: bidPlan.intentId, signed: wrongSigned });
      check("signature from the wrong wallet is refused", wrong.ok === false, wrong.reason);
      console.log(`         -> ${wrong.reason}`);

      // Same reserved nonce, but the calldata swapped for a different call.
      const s0 = bidPlan.steps[0];
      const swapped = await wallet.signTransaction({
        to: s0.to,
        data: "0x4e71d92d",
        value: BigInt(s0.value),
        nonce: Number(s0.nonce),
        gas: BigInt(s0.gas),
        maxFeePerGas: BigInt(s0.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(s0.maxPriorityFeePerGas),
        chainId: s0.chainId,
      });
      const tampered = await call(client, "pact_submit", { intentId: bidPlan.intentId, signed: [swapped] });
      check("calldata that differs from the plan is refused", tampered.ok === false, tampered.reason);
      console.log(`         -> ${tampered.reason}`);

      // And the honest one should still work afterwards.
      const goodSigned = await signSteps(wallet, bidPlan.steps);
      const good = await call(client, "pact_submit", { intentId: bidPlan.intentId, signed: goodSigned });
      check("the genuine signature still lands after two refusals", good.ok === true, good.reason);
      check("the pitch is published with the bid", good.published?.includes("pitch"), JSON.stringify(good.published));
      for (const r of good.receipts ?? []) console.log(`         -> ${r.step}: ${r.hash} (block ${r.blockNumber}, ${r.status})`);
    } else {
      check("plan bid prepared", false, bidPlan.reason);
    }
  } else {
    check("plan bid prepared", false, "the second agent's job has no id");
  }

  // ---- plan + sign + submit: a two-step job post (approve WIF, then postJob) ----
  let jobId = null;
  const terms = {
    title: "Write a landing page for a WIF escrow prototype",
    description: "One page, mobile first, explaining the escrow flow in plain language.",
    criteria: "Delivered as a public URL that renders on a phone, copy matches the brief.",
    proofSpec: "Submit the URL plus a screenshot hash; the URL must load without a login.",
    category: "design",
  };
  const nowSec = Math.floor(Date.now() / 1000);

  // Terms are hashed server-side, so a client-supplied hash that does not reproduce is refused
  // rather than posted as a job nobody can read.
  const mismatch = await call(client, "pact_plan", {
    action: "post_job",
    address: account.address,
    terms,
    termsHash: "0x" + "ab".repeat(32),
    budget: "120000000000000000000",
    bidDeadline: nowSec + 3600,
    deliveryDeadline: nowSec + 7200,
  });
  check("a terms hash that does not match the text is refused", mismatch.ok === false, mismatch.reason);

  const postPlan = await call(client, "pact_plan", {
    action: "post_job",
    address: account.address,
    terms,
    budget: "120000000000000000000",
    // One as a numeric string, one as a number: agents send unix times both ways.
    bidDeadline: String(nowSec + 3600),
    deliveryDeadline: nowSec + 7200,
  });
  if (postPlan.ok) {
    check("plan post_job carries both approve and postJob", postPlan.steps?.length === 2, String(postPlan.steps?.length));
    const posted = await call(client, "pact_submit", { intentId: postPlan.intentId, signed: await signSteps(wallet, postPlan.steps) });
    check("submit post_job lands", posted.ok === true, posted.reason);
    for (const r of posted.receipts ?? []) console.log(`         -> ${r.step}: ${r.hash} (block ${r.blockNumber}, ${r.status})`);
    check("the terms are published with the job", posted.published?.includes("terms"), JSON.stringify(posted.published));
    const after = await call(client, "pact_list_jobs", {});
    const mine = (after.jobs ?? []).find(
      (j) => j.employer.toLowerCase() === account.address.toLowerCase() && j.state === "OPEN",
    );
    check("the posted job is readable on chain", Boolean(mine), mine ? `job ${mine.jobId}` : "not found");
    console.log(`         -> posted job ${mine?.jobId}, ${mine?.budget?.wif ?? "?"} WIF locked\n`);
    jobId = mine?.jobId ?? null;

    /// Posting escrows WIF through the same allowance the bond uses. An approval that was
    /// replaced rather than topped up would strand the bid this wallet has already placed.
    const allowanceAfterPost = await call(client, "pact_whoami", { address: account.address });
    check(
      "posting a job leaves an outstanding bond approval intact",
      BigInt(allowanceAfterPost.allowanceToEscrow?.wei ?? "0") >= 50n * 10n ** 18n,
      `${allowanceAfterPost.allowanceToEscrow?.wif} WIF still approved`,
    );
  } else {
    check("plan post_job prepared", false, postPlan.reason);
  }

  // ---- sessions: prove the key once, then read what only a party may read ----
  const challenge = await call(client, "pact_session_start", { address: account.address });
  check("session: challenge explains it authorises nothing", /authorises no transfer/.test(challenge.message ?? ""));
  check("session: the message names the signing address", (challenge.message ?? "").includes(account.address.toLowerCase()));

  const signature = await wallet.signMessage({ message: challenge.message });
  const session = await call(client, "pact_session_finish", {
    address: account.address,
    nonceId: challenge.nonceId,
    signature,
  });
  check("session: a valid signature mints a token", typeof session.session === "string", session.reason);

  const replayNonce = await call(client, "pact_session_finish", {
    address: account.address,
    nonceId: challenge.nonceId,
    signature,
  });
  check("session: a challenge cannot be reused", replayNonce.ok === false, replayNonce.reason);

  const otherSigner = privateKeyToAccount(generatePrivateKey());
  const otherChallenge = await call(client, "pact_session_start", { address: account.address });
  const wrongSig = await createWalletClient({ account: otherSigner, chain, transport: http(RPC_URL) }).signMessage({
    message: otherChallenge.message,
  });
  const stolen = await call(client, "pact_session_finish", {
    address: account.address,
    nonceId: otherChallenge.nonceId,
    signature: wrongSig,
  });
  check("session: someone else's signature is refused", stolen.ok === false, stolen.reason);

  const noSession = await call(client, "pact_get_case", { jobId: jobId ?? 1, session: "not-a-token" });
  check("case file: a forged token reads nothing", noSession.allowed === false, noSession.reason);

  if (jobId) {
    const mineCase = await call(client, "pact_get_case", { jobId, session: session.session });
    check("case file: the employer reads their own job", mineCase.allowed === true, mineCase.reason);
    check("case file: the published terms are there", mineCase.terms?.title === terms.title, mineCase.terms?.title);
    check("case file: the criteria are there", mineCase.terms?.criteria === terms.criteria);

    // A stranger with a *valid* session must still be refused: authentication is not authorisation.
    const strangerKey = generatePrivateKey();
    const stranger = privateKeyToAccount(strangerKey);
    const strangerChallenge = await call(client, "pact_session_start", { address: stranger.address });
    const strangerSig = await createWalletClient({ account: stranger, chain, transport: http(RPC_URL) }).signMessage({
      message: strangerChallenge.message,
    });
    const strangerSession = await call(client, "pact_session_finish", {
      address: stranger.address,
      nonceId: strangerChallenge.nonceId,
      signature: strangerSig,
    });
    check("case file: a stranger gets a token but no rights", typeof strangerSession.session === "string");
    const strangerCase = await call(client, "pact_get_case", { jobId, session: strangerSession.session });
    check("case file: a stranger is refused on someone else's job", strangerCase.allowed === false, strangerCase.reason);
    console.log(`         -> ${strangerCase.reason}`);

    /// A job id reused by a later deployment leaves a row that belongs to the earlier one. The
    /// write path replaces it, and the read path refuses it either way. Prove the refusal by
    /// putting the wrong text in the database on purpose.
    const sql = db();
    await sql`update job_content set title = ${"a previous deployment's job"} where job_id = ${jobId}`;
    const staleCase = await call(client, "pact_get_case", { jobId, session: session.session });
    check(
      "case file: stale text in the database is refused, not served",
      staleCase.terms === null && (staleCase.missing ?? []).includes("terms"),
      JSON.stringify(staleCase.terms),
    );
    await sql`update job_content set title = ${terms.title} where job_id = ${jobId}`;
    const restoredCase = await call(client, "pact_get_case", { jobId, session: session.session });
    check("case file: the real text is served again afterwards", restoredCase.terms?.title === terms.title);

    // The token is the same HMAC token the website issues, so the web app accepts it as a session.
    const web = (process.env.PACT_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
    try {
      const res = await fetch(`${web}/api/jobs`);
      const body = await res.json();
      const served = (body.jobs ?? []).find((j) => Number(j.jobId) === jobId);
      check("the website serves the terms the agent published", served?.title === terms.title, served?.title ?? "missing");

      const me = await fetch(`${web}/api/session/me`, {
        headers: { cookie: `pact_session=${session.session}` },
      });
      const meBody = await me.json();
      check(
        "the website accepts the agent's token as a session",
        me.status === 200 && meBody.address === account.address.toLowerCase(),
        `${me.status} ${JSON.stringify(meBody)}`,
      );
    } catch (error) {
      results.push(`  SKIP  website check (${String(error.message).slice(0, 60)})`);
    }
  }

  // ---- a job that was never inscribed returns an empty record, not an error ----
  const missingRecord = await call(client, "pact_get_record", { jobId: 999999 });
  check("get_record on a missing job answers cleanly", missingRecord.found === false);

  // ---- the full lifecycle: accept, deliver, approve, settle ----
  // "self" is the agent that bid; "rival" is the agent that posted. Nothing here is scripted past
  // the plan/submit boundary — these are the same calls an outside agent makes.
  const self = { account, wallet };
  const wif = (whole) => (BigInt(whole) * 10n ** 18n).toString();

  async function submitPlan(who, args, label) {
    const planned = await call(client, "pact_plan", { address: who.account.address, ...args });
    if (!planned.ok) {
      check(`${label}: plan succeeds`, false, planned.reason);
      return null;
    }
    const done = await call(client, "pact_submit", {
      intentId: planned.intentId,
      signed: await signSteps(who.wallet, planned.steps),
    });
    check(`${label}: lands`, done.ok === true, done.reason);
    for (const r of done.receipts ?? []) console.log(`         -> ${r.step}: ${r.hash} (${r.status})`);
    return done;
  }

  if (openJobId) {
    const accepted = await submitPlan(rival, { action: "accept", jobId: openJobId, worker: account.address }, "accept by worker address");
    check("accept: the job moves to ASSIGNED", accepted?.jobState === "ASSIGNED", accepted?.jobState);

    const delivered = await submitPlan(
      self,
      {
        action: "deliver",
        jobId: openJobId,
        proof: "Deployed at https://pact.example/landing. Mobile first, copy matches the brief, source handed over.",
      },
      "deliver",
    );
    check("deliver: the deliverable is published", delivered?.published?.includes("deliverable"), JSON.stringify(delivered?.published));

    const workerCase = await call(client, "pact_get_case", { jobId: openJobId, session: session.session });
    check("case file: the worker can read the deliverable", Boolean(workerCase.deliverable?.proof), workerCase.reason);

    const approved = await submitPlan(rival, { action: "release", jobId: openJobId }, "release the payment");
    check("release: the job is SETTLED", approved?.jobState === "SETTLED", approved?.jobState);

    const settled = await submitPlan(self, { action: "settle", jobId: openJobId }, "settle: record then claim");
    check("settle: the job stays SETTLED", settled?.jobState === "SETTLED", settled?.jobState);

    const inscribed = await call(client, "pact_get_record", { jobId: openJobId });
    check("settle: the job is inscribed in the record", inscribed.inscribed === true);
    check(
      "approval pays the price minus 5% plus the whole bond",
      inscribed.paidToWorker?.wei === wif(145),
      `${inscribed.paidToWorker?.wif} WIF paid to the worker (expected 145)`,
    );
    const afterSettle = await call(client, "pact_whoami", { address: account.address });
    check("settle: nothing is left claimable", afterSettle.claimable?.wei === "0", JSON.stringify(afterSettle.claimable));
    check("settle: nothing is left blocking a claim", afterSettle.claimBlocked === false);
  }

  // ---- the dispute path: ticket, ruling, settle ----
  const disputeTerms = {
    title: "Ten articles about escrow, 800 words each",
    description: "Ten pieces, plain language, sourced. Delivered as a folder of markdown.",
    criteria: "Ten files, each at least 800 words, on the agreed topics, no placeholder text.",
    proofSpec: "A link to a folder containing all ten files, readable without a login.",
    category: "writing",
  };
  const secondPost = await submitPlan(
    rival,
    {
      action: "post_job",
      terms: disputeTerms,
      budget: wif(100),
      bidDeadline: nowSec + 3600,
      deliveryDeadline: nowSec + 86_400,
    },
    "second agent posts the dispute job",
  );
  const disputeJob = secondPost?.jobId ?? null;

  if (disputeJob) {
    await submitPlan(self, { action: "bid", jobId: disputeJob, price: wif(100), pitch: "Two a day, ten by Friday." }, "bid on the dispute job");
    const disputeAccepted = await submitPlan(rival, { action: "accept", jobId: disputeJob, bidIndex: 0 }, "accept by bid index");
    check("accept: by index works too", disputeAccepted?.jobState === "ASSIGNED", disputeAccepted?.jobState);
    await submitPlan(self, { action: "deliver", jobId: disputeJob, proof: "Folder with ten drafts, eight of them unfinished." }, "deliver badly");

    const notResolver = await call(client, "pact_plan", {
      action: "resolve",
      address: account.address,
      jobId: disputeJob,
      ruling: "worker",
    });
    check("resolve: a wallet that is not the resolver is refused", notResolver.ok === false, notResolver.reason);

    const filed = await submitPlan(
      self,
      { action: "raise_ticket", jobId: disputeJob, reason: "The employer asked for ten finished pieces and received eight drafts." },
      "worker files a ticket",
    );
    check("ticket: the job moves to DISPUTED", filed?.jobState === "DISPUTED", filed?.jobState);
    check("ticket: the complaint is published", filed?.published?.includes("complaint"), JSON.stringify(filed?.published));

    const blocked = await call(client, "pact_plan", { action: "release_expired", address: account.address, jobId: disputeJob });
    check("a ticket stops the auto-release route", blocked.ok === false, blocked.reason);

    if (FUNDER_KEY) {
      const resolverAccount = privateKeyToAccount(FUNDER_KEY);
      const resolver = {
        account: resolverAccount,
        wallet: createWalletClient({ account: resolverAccount, chain, transport: http(RPC_URL) }),
      };
      const ruled = await submitPlan(
        resolver,
        {
          action: "resolve",
          jobId: disputeJob,
          ruling: "worker",
          fineBps: 0,
          note: "The brief asked for ten finished pieces; eight drafts is not delivery.",
        },
        "the resolver rules for the worker",
      );
      check("resolve: the job is SETTLED", ruled?.jobState === "SETTLED", ruled?.jobState);

      const settledAfter = await submitPlan(self, { action: "settle", jobId: disputeJob }, "settle after the ruling");
      check("settle after a ruling: SETTLED", settledAfter?.jobState === "SETTLED", settledAfter?.jobState);

      const rulingRecord = await call(client, "pact_get_record", { jobId: disputeJob });
      check("the ruling is inscribed", rulingRecord.inscribed === true);
      // Worker filed (-10 filing fee from the bond) and won: 100 - 5 cut + 40 bond = 135.
      check(
        "a won ticket pays price minus 5% plus the bond after the fee",
        rulingRecord.paidToWorker?.wei === wif(135),
        `${rulingRecord.paidToWorker?.wif} WIF paid to the worker (expected 135)`,
      );
      check("the record says the worker won", rulingRecord.workerWon === true);

      const caseAfter = await call(client, "pact_get_case", { jobId: disputeJob, session: session.session });
      check("case file: the ruling note is there for the parties", Boolean(caseAfter.ruling?.note), caseAfter.ruling?.note);
    } else {
      results.push("  SKIP  the resolver step (set PACT_FUNDER_KEY to act as the resolver)");
    }
  }

  // ---- cleanup: cancel anything this run left OPEN, so the live feed is not littered ----
  if (jobId) {
    const cancelPlan = await call(client, "pact_plan", { action: "cancel", address: account.address, jobId });
    if (cancelPlan.ok) {
      const cancelled = await call(client, "pact_submit", {
        intentId: cancelPlan.intentId,
        signed: await signSteps(wallet, cancelPlan.steps),
      });
      check("cancel refunds an open job", cancelled.ok === true && cancelled.jobState === "CANCELLED", cancelled.reason);
      console.log(`         -> job ${jobId} cancelled: ${cancelled.next?.[0] ?? ""}`);
    } else {
      check("cancel plans", false, cancelPlan.reason);
    }
  }

  // ---- an abandoned plan must not leave a hole in the nonce sequence ----
  // A plan prepared and then dropped used to advance the ledger for good: every later transaction
  // from that wallet was signed above a nonce the chain never saw, so it queued behind a hole and
  // never got a receipt. Reservations now expire, so the range is reusable.
  const ghost = await spawnAgent("ghost", { register: false });
  const firstPlan = await call(client, "pact_plan", {
    action: "register",
    address: ghost.account.address,
    name: `ghost${Math.floor(Math.random() * 1e6)}`,
    kind: 1,
  });
  check("a plan can be prepared and then dropped", firstPlan.ok === true, firstPlan.reason);
  const abandonedNonce = Number(firstPlan.steps?.[0]?.nonce);

  const whileLive = await call(client, "pact_plan", {
    action: "register",
    address: ghost.account.address,
    name: `ghost${Math.floor(Math.random() * 1e6)}`,
    kind: 1,
  });
  check(
    "only one plan per address is live: the newer one supersedes the older and reuses its nonce",
    Number(whileLive.steps?.[0]?.nonce) === abandonedNonce && (whileLive.supersededPlans ?? 0) >= 1,
    `first ${abandonedNonce}, second ${whileLive.steps?.[0]?.nonce}, superseded ${whileLive.supersededPlans}`,
  );

  /// And the superseded plan must not be submittable: two live plans used to hand out the same
  /// nonces, so an agent settling two jobs at once signed both onto one nonce and the second
  /// reverted. One live plan at a time is the fix, and a refused submit is what it looks like.
  const supersededSubmit = await call(client, "pact_submit", {
    intentId: firstPlan.intentId,
    signed: await signSteps(ghost.wallet, firstPlan.steps),
  });
  check("the superseded plan is refused on submit", supersededSubmit.ok === false, supersededSubmit.reason);
  console.log(`         -> ${supersededSubmit.reason}`);

  /// Stand in for time passing: the reservation and its intent both expire.
  const sql = db();
  await sql`update mcp_reservation set expires_at = now() - interval '1 second' where lower(address) = ${ghost.account.address.toLowerCase()}`;

  const healed = await call(client, "pact_plan", {
    action: "register",
    address: ghost.account.address,
    name: `healed${Math.floor(Math.random() * 1e6)}`,
    kind: 1,
  });
  check(
    "an expired reservation is reused rather than skipped",
    Number(healed.steps?.[0]?.nonce) === abandonedNonce,
    `expected nonce ${abandonedNonce}, got ${healed.steps?.[0]?.nonce}`,
  );
  console.log(`         -> abandoned ${abandonedNonce}, guarded ${whileLive.steps?.[0]?.nonce}, reused ${healed.steps?.[0]?.nonce}`);

  const healedSubmit = await call(client, "pact_submit", {
    intentId: healed.intentId,
    signed: await signSteps(ghost.wallet, healed.steps),
  });
  check("the healed plan lands on chain", healedSubmit.ok === true, healedSubmit.reason);
  const ghostWhoami = await call(client, "pact_whoami", { address: ghost.account.address });
  check("the ghost agent is registered at the reused nonce", ghostWhoami.registered === true, ghostWhoami.username);

  // A signed plan whose nonce the chain has already passed must be refused with a reason, not sent.
  const stalePlan = await call(client, "pact_plan", {
    action: "approve",
    address: ghost.account.address,
    amount: "1",
  });
  if (stalePlan.ok) {
    const signedStale = await signSteps(ghost.wallet, stalePlan.steps);
    /// Spend that nonce with a plain self-transfer, so the plan is stale by construction.
    const burn = await ghost.wallet.sendTransaction({
      to: ghost.account.address,
      value: 0n,
      nonce: Number(stalePlan.steps[0].nonce),
    });
    await publicClient.waitForTransactionReceipt({ hash: burn });
    const refused = await call(client, "pact_submit", { intentId: stalePlan.intentId, signed: signedStale });
    check("a plan whose nonce the chain has passed is refused with a reason", refused.ok === false, refused.reason);
    console.log(`         -> ${refused.reason}`);
  } else {
    check("the stale-plan probe could be prepared", false, stalePlan.reason);
  }

  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);

  await client.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("harness crashed:", error);
  process.exit(1);
});
