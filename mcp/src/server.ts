import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, type Address } from "./config.js";
import { getCase, getJob, getProfile, getRecord, listJobs, whoami } from "./tools/reads.js";
import { plan } from "./tools/plan.js";
import { submit } from "./tools/submit.js";
import { finishSession, startSession } from "./session.js";
import { findTalent } from "./talents.js";
import { quoteSwap } from "./swap-tools.js";

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed 20-byte address")
  .describe("the wallet address, 0x-prefixed");

// Agents send unix times as numbers or as numeric strings depending on the runtime. Accept both —
// a rejected unit is a wasted round trip, not a safety property.
const unixSeconds = z
  .union([z.number().int().positive(), z.string().regex(/^[0-9]+$/, "unix seconds")])
  .transform((value) => Number(value));

function json(value: unknown) {
  // Bigints reach the surface from chain reads. Serialise them rather than letting one throw
  // and turn a successful read into an opaque protocol error.
  const text = JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  return { content: [{ type: "text" as const, text: text ?? "null" }] };
}

/// The interface an agent uses. Every tool is either a read of on-chain state or a step in a
/// prepare → sign → submit flow. There is deliberately no tool that signs, sends an arbitrary
/// transaction, or names a recipient.
export function buildServer(): McpServer {
  const server = new McpServer({
    name: "pact",
    version: "0.1.0",
  });

  server.registerTool(
    "pact_whoami",
    {
      title: "Who am I",
      description:
        "Everything this wallet can and cannot do right now: whether it has a username, its WIF balance and allowance, what it can claim, and whether a record is blocking that claim. Start here.",
      inputSchema: { address: addressSchema },
    },
    async ({ address }) => json(await whoami(address as Address)),
  );

  server.registerTool(
    "pact_quote_swap",
    {
      title: "Price a WIF trade",
      description:
        "What the Uniswap v4 ETH/WIF pool would pay right now, for a buy or a sell, including the 1% hook fee. Read-only and needs no signature. Use it before planning a pact_plan swap so the size is chosen against a real price rather than a guess.",
      inputSchema: {
        side: z.enum(["buy", "sell"]).describe("buy WIF with ETH, or sell WIF for ETH"),
        amountIn: z.string().regex(/^[0-9]+$/, "an amount in wei").describe("how much goes in, in wei (18 decimals)"),
        slippageBps: z.number().int().min(0).max(2000).optional().describe("tolerance in bps, default 100"),
      },
    },
    async ({ side, amountIn, slippageBps }) => json(await quoteSwap({ side, amountIn, slippageBps })),
  );

  server.registerTool(
    "pact_list_jobs",
    {
      title: "List jobs",
      description:
        "Browse jobs, newest first. Filter by state (OPEN, ASSIGNED, DELIVERED, DISPUTED, SETTLED, CANCELLED), minimum budget in WIF, or employer. Open jobs past their bid window are hidden by default, because nobody can win them and they are noise on a work board.",
      inputSchema: {
        state: z.string().optional().describe("OPEN, ASSIGNED, DELIVERED, DISPUTED, SETTLED or CANCELLED"),
        minBudgetWif: z.number().optional().describe("minimum budget, in whole WIF"),
        employer: addressSchema.optional(),
        limit: z.number().int().min(1).max(50).optional().describe("how many jobs to return, 50 at most"),
        includeUnbiddable: z
          .boolean()
          .optional()
          .describe("include open jobs whose bidding window has closed. Default false; use it to find your own expired job"),
        biddableOnly: z
          .boolean()
          .optional()
          .describe("deprecated alias: pass false to include jobs that can no longer be bid on"),
      },
    },
    async (args) => json(await listJobs(args)),
  );

/// Register the discovery surface: who to hire, and who has delivered.
  server.registerTool(
    "pact_find_talent",
    {
      title: "Find workers and employers",
      description:
        "Search the registry for the wallet best suited to a job, or check who competes with you. Ranked by counts of settled work, never by a grade: every row returns its own inputs so you can recompute the rank. Boards: workers (jobs done minus tickets lost minus abandonments), employers (settled jobs minus tickets lost), earners and payers (net WIF), disputes (tickets won). Reads PactNames.profileOf for every registered wallet in one multicall; nothing is indexed off chain.",
      inputSchema: {
        board: z
          .enum(["workers", "employers", "earners", "payers", "disputes"])
          .optional()
          .describe("which ranking to sort by; workers by default"),
        query: z
          .string()
          .optional()
          .describe("a username fragment, or an address (at least four characters)"),
        kind: z.enum(["AI", "HUMAN"]).optional().describe("only agents, or only humans"),
        rankedOnly: z
          .boolean()
          .optional()
          .describe("drop wallets with no settled work. Default false: new wallets are listed last, since they need to be hireable"),
        limit: z.number().int().min(1).max(50).optional().describe("how many rows, 10 by default"),
      },
    },
    async (args) => json(await findTalent(args)),
  );

  server.registerTool(
    "pact_get_job",
    {
      title: "Get one job",
      description:
        "Full state of a job: who is involved, the money, the deadlines, the bond required, every bid (with each bidder's username and index), the published terms, the two commitment hashes, and — once settled — who won and what each side was credited. `employer` and `worker` are both { address, username }, and `worker` is null until a bid is accepted. Terms are public; the deliverable text and any complaint are not returned here.",
      inputSchema: { jobId: z.number().int().positive().describe("which job") },
    },
    async ({ jobId }) => json(await getJob(jobId)),
  );

  server.registerTool(
    "pact_get_profile",
    {
      title: "Get a reputation profile",
      description:
        "A wallet's username and its settlement-backed record: jobs posted, jobs done, tickets, WIF earned as a worker and spent as an employer. These numbers come from the escrow, not from feedback.",
      inputSchema: { address: addressSchema },
    },
    async ({ address }) => json(await getProfile(address as Address)),
  );

  server.registerTool(
    "pact_session_start",
    {
      title: "Start a session",
      description:
        "Step 1 of proving you hold a wallet key. Returns the exact message to sign with personal_sign (no gas, authorises no transfer) and a nonceId to hand back. Needed only for reading private things: a deliverable, a complaint.",
      inputSchema: { address: addressSchema },
    },
    async ({ address }) => json(await startSession(address as Address)),
  );

  server.registerTool(
    "pact_session_finish",
    {
      title: "Finish a session",
      description:
        "Step 2. Pass the signature of the message from pact_session_start and receive a session token. Pass that token to pact_get_case. The token is a bearer credential for reading, nothing else — it cannot move funds.",
      inputSchema: {
        address: addressSchema,
        nonceId: z.string().describe("the nonceId returned by pact_session_start"),
        signature: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/, "a 0x-prefixed signature")
          .describe("the EIP-191 signature of the returned message, made with personal_sign"),
      },
    },
    async ({ address, nonceId, signature }) =>
      json(await finishSession(address as Address, nonceId, signature as `0x${string}`)),
  );

  server.registerTool(
    "pact_get_case",
    {
      title: "Read the case file",
      description:
        "The terms, the deliverable and the complaint for one job, plus what is locked and when it unlocks. Only the employer, the worker and the resolver of that job may read the private parts; anyone else holding a valid session is refused. Terms are also public via pact_get_job; use this tool when you need the deliverable or the complaint, to judge a delivery.",
      inputSchema: {
        jobId: z.number().int().positive(),
        session: z.string().describe("the token from pact_session_finish"),
      },
    },
    async ({ jobId, session }) => json(await getCase(jobId, session)),
  );

  server.registerTool(
    "pact_get_record",
    {
      title: "Get a settlement record",
      description:
        "The permanent entry written when a settled job was inscribed: both parties, both hashes, who won, what was paid, and when. Empty fields mean the job has not been recorded yet.",
      inputSchema: { jobId: z.number().int().positive().describe("which job") },
    },
    async ({ jobId }) => json(await getRecord(jobId)),
  );

  server.registerTool(
    "pact_plan",
    {
      title: "Plan a write",
      description:
        "Prepare the transaction(s) for one action. Returns unsigned transactions, the nonces reserved for them, and a plain-language summary. Nothing is sent. Sign exactly these transactions and pass them to pact_submit. Every precondition is checked first, so a refusal tells you what to fix before you sign.",
      inputSchema: {
        action: z.enum([
          "register",
          "approve",
          "post_job",
          "bid",
          "cancel",
          "cancel_expired",
          "withdraw_bid",
          "accept",
          "deliver",
          "release",
          "raise_ticket",
          "resolve",
          "settle",
          "abandon",
          "release_expired",
          "reclaim_assignment",
          "timeout_dispute",
          "swap",
        ]),
        address: addressSchema.describe("the wallet that will sign and send"),
        name: z.string().optional().describe("register: the username to claim"),
        kind: z.number().int().min(0).max(1).optional().describe("register: 0 = human, 1 = AI agent"),
        amount: z.string().optional().describe("approve: how much WIF to allow, in wei"),
        terms: z
          .object({
            title: z.string(),
            description: z.string(),
            criteria: z.string(),
            proofSpec: z.string(),
            category: z.string(),
            expectedProofHash: z
              .string()
              .regex(/^0x[0-9a-fA-F]{64}$/)
              .optional()
              .describe(
                "post_job: optional. The exact keccak256 digest of the deliverable you will accept. Naming it makes the job self-verifying: a delivery either matches it or it does not, and no resolver has to judge anything",
              ),
          })
          .optional()
          .describe(
            "post_job: the job text. The server hashes it and publishes it after the transaction confirms, so it cannot drift from what was committed",
          ),
        termsHash: z
          .string()
          .optional()
          .describe("post_job: a 32-byte commitment, if you are hashing the terms yourself. Prefer `terms`"),
        budget: z.string().optional().describe("post_job: the full price to escrow, in wei"),
        bidDeadline: unixSeconds.optional().describe("post_job: unix seconds when bidding closes"),
        deliveryDeadline: unixSeconds.optional().describe("post_job: unix seconds when work is due"),
        autoReleaseSeconds: z
          .number()
          .int()
          .min(60)
          .max(365 * 24 * 60 * 60)
          .optional()
          .describe(
            "post_job: how long you have after delivery before anyone may pay the worker automatically. A bidder prices this, so it belongs to the job rather than to the deployment. Omit to use the deployment default",
          ),
        jobId: z.number().int().positive().optional().describe("bid, cancel, accept, deliver, release, raise_ticket, resolve, settle, abandon, release_expired: which job"),
        price: z.string().optional().describe("bid: your price in wei"),
        pitch: z.string().optional().describe("bid: a short note to the employer, published after the bid lands"),
        bidIndex: z.number().int().min(0).optional().describe("accept: which bid, as listed by get_job"),
        worker: z
          .string()
          .optional()
          .describe("accept: the worker whose bid to accept, if you would rather not use an index"),
        proof: z
          .string()
          .optional()
          .describe("deliver: the deliverable itself. The server hashes it and publishes it after the receipt"),
        proofHash: z.string().optional().describe("deliver: a 32-byte commitment, if you are hashing it yourself"),
        reason: z
          .string()
          .optional()
          .describe("raise_ticket: the complaint. The server hashes it and publishes it after the receipt"),
        reasonHash: z.string().optional().describe("raise_ticket: a 32-byte commitment, if you are hashing it yourself"),
        ruling: z.enum(["worker", "employer"]).optional().describe("resolve: which side wins. There is no third option"),
        fineBps: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe("resolve: the fine on the losing party's escrow, in basis points, 0 to 1000 (1000 = 10%)"),
        side: z.enum(["buy", "sell"]).optional().describe("swap: buy WIF with ETH, or sell WIF for ETH"),
        amountIn: z
          .string()
          .regex(/^[0-9]+$/, "an amount in wei")
          .optional()
          .describe("swap: how much goes in, in wei. ETH when buying, WIF when selling"),
        slippageBps: z
          .number()
          .int()
          .min(0)
          .max(2000)
          .optional()
          .describe("swap: tolerance below the quote, in bps. Default 100"),
        deadlineSeconds: z
          .number()
          .int()
          .min(60)
          .max(1800)
          .optional()
          .describe("swap: how long the swap may be mined for, in seconds. Default 600"),
        note: z.string().optional().describe("resolve: why you ruled this way. Published for the two parties"),
      },
    },
    async (args) => {
      const result = await plan(args as never);
      if (!result.ok) return json(result);
      return json({
        ok: true,
        intentId: result.intent.id,
        action: result.intent.action,
        summary: result.intent.summary,
        checks: result.intent.cheque,
        expiresAt: result.intent.expiresAt.toISOString(),
        steps: result.intent.steps.map((s) => ({
          label: s.label,
          to: s.to,
          data: s.data,
          value: s.value,
          nonce: s.nonce,
          gas: s.gas,
          maxFeePerGas: s.maxFeePerGas,
          maxPriorityFeePerGas: s.maxPriorityFeePerGas,
          chainId: config.chainId,
        })),
        howToFinish: `sign each transaction with ${args.address} on chain ${config.chainId} and pass the signed hex strings to pact_submit with intentId ${result.intent.id}`,
        supersededPlans: result.superseded,
        note:
          result.superseded > 0
            ? `${result.superseded} earlier plan(s) from this wallet can no longer be submitted: only one plan is live per address, and this one replaced them.`
            : undefined,
      });
    },
  );

  server.registerTool(
    "pact_submit",
    {
      title: "Submit signed transactions",
      description:
        "Hand back the signed transactions for an intent. Every one is checked against the plan before anything is broadcast: chain id, target contract, calldata, nonce and signer must all match, or nothing is sent. Waits for the receipts, then reports the resulting state.",
      inputSchema: {
        intentId: z.string().uuid(),
        signed: z.array(z.string()).min(1).describe("the signed transactions, in the order they were prepared"),
      },
    },
    async ({ intentId, signed }) => json(await submit({ intentId, signed })),
  );

  return server;
}
