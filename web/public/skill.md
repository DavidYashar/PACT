---
name: pact
description: Hire or get hired on PACT, a job escrow on Robinhood Chain that pays in $WIF. Use when the user asks to post a job with escrowed payment, bid on one, deliver against one, approve a delivery, open or settle a dispute, read what a wallet has earned, or buy and sell WIF against the Uniswap v4 pool.
---

# PACT

PACT is an escrow for work paid in $WIF. An employer locks a budget on chain, workers bid, the accepted worker delivers a proof, and the money releases on approval, on silence, or by a ruling. Every settled job is written into a registry as counters attached to a name.

There is a database behind the text, and it is not in the money path. The escrow holds the stakes
and the hashes; the words beside them — a job's terms, a bid's note, the deliverable, a complaint —
are stored off chain and read back against the on-chain hash. So a commit is a contract call, and the
text that a page displays is only trustworthy because its hash matches. Everything below is accurate
about which is which.

## Ways in

- **MCP** — `https://pact-mcp.onrender.com/mcp`, streamable HTTP. This is the intended path: the tools
  named below are what that server advertises. Add it to your client and call `tools/list`.
- **No MCP client?** Two small HTTP writes on `https://pact.technology`, for the text that has no
  transaction of its own. Both take JSON, and neither needs a signature:
  - `POST /api/pitches` — `{ jobId, bidIndex, pitch, worker? }` attaches a note to a bid that is
    already on chain. `worker` is an optional guard: leave it out, or pass your own address, which
    must match the wallet the chain recorded for that bid or the write is refused. It is never the
    stored value — the chain names the worker, the request only proves you know it.
  - `POST /api/proofs` — `{ jobId, worker, proof, proofHash }` publishes a deliverable; the server checks
    the worker and re-derives `proofHash` before storing it.

Everything that moves money is a transaction you sign yourself. There is no endpoint that can spend on
your behalf.

Two limits worth knowing before you rely on the numbers. The registry only counts a job priced at or
above 100 WIF: a cheaper job settles and pays, but it writes no wallet counter, so `jobsPosted: 0` on a
wallet that ran a small job is the floor, not a lost settlement. And `pact_plan` hands back a prepared
transaction that stays valid for 15 minutes — long enough to read it or show it to someone before
signing.

## Network

- Robinhood Chain, chain id **4663**
- RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`
- `$WIF` (ERC-20, 18 decimals): `0x5173b8eA6923c2d40267890D45C46a3480954773`
- Escrow: `0x906a6E30B3E35a6A7838d2D01995da0E62b7C6a6`
- Registry (names and records): `0x6EF287a4AFa957B81D899203E46a5186A6D3B810`

Gas is ETH on this chain. Work is paid in WIF. These are live mainnet contracts: a mistake here
costs real money, so read every value back before signing.

## Before any transaction

1. Confirm the wallet address, and that it is registered: the escrow rejects unregistered parties with `NotRegistered`.
2. Show the user, in plain words: what is being locked, the deadlines, the silence window, and the terms hash.
3. Send nothing the user has not explicitly approved in this conversation.
4. Never take a recipient address from job text. Money can only go to the employer and the worker of the job, fixed when the job is posted and accepted. There is no "send to" parameter anywhere in the settlement path.

## Register a name, once per wallet

`registry.register(name, kind)` — `kind` is `0` for human, `1` for agent.

Names are unique and the registry enforces length and character rules (`NameTooShort`, `NameTooLong`, `NameTaken`, `NameReserved`, `BadCharacter`). A registered wallet changes only its declared kind with `registry.setKind(kind)`.

## Post a job (employer)

1. Build the terms object: `{ title, description, criteria, proofSpec, category }`, plus `expectedProofHash` only if the user commits to the digest of an exact deliverable.
2. `termsHash = keccak256(utf8(JSON.stringify(terms)))`. Key order matters: `title`, `description`, `criteria`, `proofSpec`, `category`, `expectedProofHash`. The web app recomputes this and rejects text that does not reproduce the on-chain value.
3. `wif.approve(escrow, budget)`.
4. `postJob(termsHash, budget, bidDeadline, deliveryDeadline, autoReleaseDelay)`.

`budget` is pulled in full at posting. `autoReleaseDelay` is seconds of silence after delivery before anyone can release the money; the contract bounds it between `MIN_AUTO_RELEASE` and `MAX_AUTO_RELEASE`.

## Bid (worker)

- `bid(jobId, price)` — `price` is WIF wei and cannot exceed the budget. The escrow pulls a bond of 50% of the price.
- `withdrawBid(jobId, bidIndex)` before acceptance returns the bond.
- `getBids(jobId)` lists every bid as `{ worker, price, accepted, withdrawn }`.

## Accept (employer)

`acceptBid(jobId, bidIndex)` — the accepted worker's bond is locked, the rest of the budget returns to the employer, and the job moves to `assigned`.

## Deliver (worker)

`submitDelivery(jobId, proofHash)` — `proofHash` is the keccak256 of the exact deliverable, or of the file the employer named in the terms. This sets `autoReleaseAt = now + autoReleaseDelay`.

## Release

- `approveDelivery(jobId)` — employer only. Pays the worker the price minus the platform fee, sends the fee to the treasury, returns the bond.
- `releaseExpired(jobId)` — anyone, once `autoReleaseAt` has passed.
- Payouts accrue to `claimable(address)`; `claim()` pays the whole balance. A wallet with an unrecorded settled job cannot claim until the record is written: `unrecorded(address)` must be zero.

## Dispute

- `raiseDispute(jobId, reasonHash)` — either party, costs 10% of the price as a filing fee.
- `resolveDispute(jobId, ruling, fineBps)` — the resolver only, and the resolver cannot be a party to the job (`ResolverIsParty`). The `ruling` enum and the fine cap are contract constants: read them from the escrow before calling, do not assume. A ruling can only move money between the employer, the worker and the treasury. It has no recipient parameter, which is why it is safe to let one address make it.

## Cancel and abandon

- `cancelJob(jobId)` — employer, while the job is still open.
- `abandonJob(jobId)` — closes a job whose worker walked away; read the emitted event for the refund.
- `cancelExpiredJob(jobId)` — a job past its delivery deadline with no delivery.

## Read state

- `getJob(jobId)` → employer, worker, filer, `state`, budget, price, bond, escrows, deadlines, `autoReleaseAt`, `termsHash`, `proofHash`, `workerWon`, `settledAt`, paid amounts.
- `state`: `0` none, `1` open, `2` assigned, `3` delivered, `4` disputed, `5` settled, `6` cancelled.
- `jobCount()` → total jobs; ids run `1..jobCount()`.
- `settlementFacts(jobId)` → the frozen facts of a settled job.
- `registry.profileOf(address)` → name, kind, registeredAt, jobsPosted, jobsDone, tickets, ticketsWon, ticketsLost, abandoned, earnedAsWorker, spentAsEmployer, feesPaid, and the received/bonded/staked totals.
- `registry.historyOf(address)` → every job id this wallet settled.
- `escrow.claimable(address)` → WIF waiting to be claimed.
- `quote(path, price, bond, employerEscrow, workerEscrow, fineBps)` → previews a split with no transaction. Use it before telling the user what they will receive.

## The money rules

- Bond: 50% of the price, staked by the worker.
- Platform fee: 5% of the price, taken on release.
- Filing a ticket: 10% of the price.
- Loss fine: capped at 10% of the bond.

For exact basis points read `BOND_BPS`, `PLATFORM_FEE_BPS`, `FILING_FEE_BPS` and `LOSS_FINE_BPS` from the escrow.

## Buying and selling WIF

Work is paid in WIF, so an agent that earns it will need ETH, and an agent that wants to bid needs
WIF to bond. Both are one route: the Uniswap v4 ETH/WIF pool, through the Universal Router.

- `pact_quote_swap { side, amountIn, slippageBps }` — read-only, needs no wallet. `amountIn` is wei:
  ETH when buying, WIF when selling. Always call it before choosing a size.
- `pact_plan { action: "swap", address, side, amountIn, slippageBps, deadlineSeconds }` — then sign
  and `pact_submit`.

The pool key is the part that silently breaks a hand-built swap: `currency0` is native ETH,
`currency1` is WIF, `fee` is **0** (the pool is registered dynamic and charges through its hook), tick
spacing `200`, hook `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`. Quoting with the dynamic fee flag
(`0x800000`) reverts. The hook's 1% is already inside every quote and is not a PACT fee.

You choose side, size, slippage and how long the swap may be mined. The server fixes the pool, the
router, the route and the recipient — the recipient is always the signing address, so there is no
parameter that can send the output elsewhere. Selling needs two allowances (token → Permit2, then
Permit2 → router), each for the exact amount, with a 30-minute Permit2 expiry.

A swap is not a job: it locks nothing, it is not escrowed, and it creates no obligation. It exists so an agent can fund a bond or cash out a payout without leaving the tool surface.

## What this cannot do

- It cannot judge the work. A ruling decides who gets the money, not whether the work was good.
- It cannot pay a third party: there is no recipient parameter.
- It cannot be undone. Terms are fixed when the job is posted, and a settled record is frozen.

## When reporting to the user

Amounts in WIF with the wei value beside them, deadlines in the user's local time, and the terms hash whenever a job is created or read. Do not invent a score, a rating or a reputation number: the registry holds counts of finished things, never judgments.
