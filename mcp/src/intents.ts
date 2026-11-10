import { randomUUID } from "node:crypto";
import { config, type Address } from "./config.js";
import { db } from "./db.js";

/// One prepared step. Everything is stored as strings so the record round-trips through jsonb
/// without losing bigints, and so comparison against a decoded transaction is exact.
export type Step = {
  label: string;
  to: Address;
  data: `0x${string}`;
  value: string;
  nonce: string;
  gas: string;
  /// Fees are resolved here rather than by the agent, so the prepared transaction is complete
  /// and signable as-is. On this chain they are negligible, but leaving them out would force
  /// every agent to implement fee logic.
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /// What this step is supposed to do. The submitter decodes the signed transaction and
  /// compares against this, so a signature can never carry a different call.
  fn: string;
  args: string[];
};

export type Intent = {
  id: string;
  address: Address;
  action: string;
  steps: Step[];
  summary: string;
  cheque: Record<string, unknown>;
  status: "pending" | "consumed" | "expired" | "superseded";
  reservationId: string | null;
  createdAt: Date;
  expiresAt: Date;
};

let ready = false;

async function ensureSchema(): Promise<void> {
  if (ready) return;
  const client = db();
  /// A reservation is a claim on a nonce range that exists *before* the intent does, so two
  /// concurrent plans cannot be handed the same nonces. Crucially it expires: an abandoned plan
  /// stops holding its range, and the next plan reuses it instead of leaving a hole behind.
  await client`
    create table if not exists mcp_reservation (
      id         text primary key,
      address    text not null,
      from_nonce bigint not null,
      to_nonce   bigint not null,
      expires_at timestamptz not null
    )`;
  await client`create index if not exists mcp_reservation_address_idx on mcp_reservation (address, expires_at)`;
  await client`
    create table if not exists mcp_intent (
      id         text primary key,
      address    text not null,
      action     text not null,
      summary    text not null,
      cheque     jsonb not null default '{}'::jsonb,
      steps      jsonb not null,
      status     text not null default 'pending',
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )`;
  await client`create index if not exists mcp_intent_address_idx on mcp_intent (address, status)`;
  await client`alter table mcp_intent add column if not exists reservation_id text`;
  /// Superseded by mcp_reservation. Kept only so an existing database does not need a migration;
  /// nothing reads it any more.
  await client`drop table if exists mcp_nonce`;
  ready = true;
}

export type Reservation = { id: string; nonces: bigint[]; expiresAt: Date; superseded: number };

/// Reserve a contiguous nonce range for this address, atomically, across every server instance.
///
/// The floor is the greater of the chain's pending nonce and the highest nonce still held by a
/// *live* reservation. Nothing else is trusted: a plan that is prepared and then abandoned expires
/// after `intentTtlSeconds` and stops holding its range, so the next plan reuses those nonces rather
/// than signing above a hole the chain will never fill. A hole would leave the agent's later
/// transactions queued behind a nonce that never arrives, and the failure would look like a server
/// bug rather than an abandoned plan.
export async function reserveNonces(address: Address, count: number, chainNonce: bigint): Promise<Reservation> {
  await ensureSchema();
  const client = db();
  const account = address.toLowerCase();
  const id = randomUUID();
  /// Longer than the intent's own lifetime by a minute, so a plan stays submittable for its whole
  /// window without its nonces being handed to someone else in the last second of it.
  const expiresAt = new Date(Date.now() + (config.intentTtlSeconds + 60) * 1000);

  return client.begin(async (tx) => {
    /// Serialise reservations per address, so two instances cannot compute the same floor.
    await tx`select pg_advisory_xact_lock(hashtext(${`pact-nonce:${account}`}))`;

    /// Retention. Nothing used to remove a spent row, and this is the largest table in the
    /// database — mostly expired plans. Seven days is long enough to debug a session and short
    /// enough that the table stops growing without bound.
    await tx`delete from mcp_intent where expires_at < now() - interval '7 days'`;
    await tx`delete from mcp_reservation where expires_at < now() - interval '1 day'`;

    /// One live plan per address. If an earlier plan was prepared and never submitted, it must not
    /// keep holding a nonce the chain never saw — otherwise the next plan is issued above a hole,
    /// submit refuses it, and the agent is stuck until the older plan expires. An address with two
    /// live plans is already a broken setup: one key, one plan.
    const retired = await tx`
      update mcp_intent set status = 'superseded'
      where address = ${account} and status = 'pending' and expires_at > now()
      returning id`;
    await tx`delete from mcp_reservation where address = ${account}`;

    const rows = await tx<{ floor: string }[]>`
      select greatest(
               ${chainNonce.toString()}::bigint,
               coalesce((select max(to_nonce) + 1 from mcp_reservation
                         where address = ${account} and expires_at > now()), 0)::bigint
             ) as floor`;

    const floor = BigInt(rows[0].floor);
    const to = floor + BigInt(count) - 1n;
    await tx`
      insert into mcp_reservation (id, address, from_nonce, to_nonce, expires_at)
      values (${id}, ${account}, ${floor.toString()}, ${to.toString()}, ${expiresAt})`;

    return {
      id,
      nonces: Array.from({ length: count }, (_, i) => floor + BigInt(i)),
      expiresAt,
      superseded: retired.length,
    };
  });
}

/// Drop a reservation once its transactions are on chain. The chain nonce has moved past it, so
/// holding the row any longer would only push the next plan higher than it needs to be.
export async function releaseReservation(id: string): Promise<void> {
  await ensureSchema();
  await db()`delete from mcp_reservation where id = ${id}`;
}

export async function createIntent(input: {
  address: Address;
  action: string;
  summary: string;
  cheque: Record<string, unknown>;
  steps: Step[];
  reservationId: string;
}): Promise<Intent> {
  await ensureSchema();
  const client = db();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + config.intentTtlSeconds * 1000);
  await client`
    insert into mcp_intent (id, address, action, summary, cheque, steps, status, expires_at, reservation_id)
    values (${id}, ${input.address.toLowerCase()}, ${input.action}, ${input.summary},
            ${client.json(input.cheque as never)}, ${client.json(input.steps as never)},
            'pending', ${expiresAt}, ${input.reservationId})`;
  return {
    id,
    address: input.address,
    action: input.action,
    summary: input.summary,
    cheque: input.cheque,
    steps: input.steps,
    status: "pending",
    reservationId: input.reservationId,
    createdAt: new Date(),
    expiresAt,
  };
}

/// The plan this wallet could still submit, if any. Used to pace `pact_plan`: a plan that was
/// refused never reaches the ledger, so a refusal never blocks the next attempt.
export async function newestPendingIntent(
  address: Address,
): Promise<{ id: string; action: string; createdAt: Date } | null> {
  await ensureSchema();
  const client = db();
  const rows = await client<{ id: string; action: string; created_at: Date }[]>`
    select id, action, created_at from mcp_intent
    where address = ${address.toLowerCase()} and status = 'pending' and expires_at > now()
    order by created_at desc limit 1`;
  const row = rows[0];
  return row ? { id: row.id, action: row.action, createdAt: row.created_at } : null;
}

export async function getIntent(id: string): Promise<Intent | null> {
  await ensureSchema();
  const client = db();
  const rows = await client<
    {
      id: string;
      address: string;
      action: string;
      summary: string;
      cheque: Record<string, unknown>;
      steps: Step[];
      status: Intent["status"];
      reservation_id: string | null;
      created_at: Date;
      expires_at: Date;
    }[]
  >`select * from mcp_intent where id = ${id} limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    address: row.address as Address,
    action: row.action,
    summary: row.summary,
    cheque: row.cheque,
    steps: row.steps,
    status: row.status,
    reservationId: row.reservation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/// Claim an intent for exactly one submission. A second submit loses the race here rather than
/// on chain, so a replayed signature cannot broadcast twice.
export async function claimIntent(id: string): Promise<boolean> {
  await ensureSchema();
  const client = db();
  const rows = await client`
    update mcp_intent set status = 'consumed'
    where id = ${id} and status = 'pending' and expires_at > now()
    returning id`;
  return rows.length > 0;
}
