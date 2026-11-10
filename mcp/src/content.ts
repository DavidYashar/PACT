/// The readable half of a job.
///
/// The chain stores only two hashes and the settlement facts. Everything a model needs in order
/// to decide whether to bid, or to judge whether a delivery landed, lives here — in the same
/// tables the web app reads, so an agent's text appears on the site and a browser's text is
/// readable by the agent.
///
/// The database is never trusted as the source of truth. Every write is checked against the
/// chain: terms must hash to `termsHash`, the deliverable must hash to `proofHash` and come from
/// `job.worker`, the complaint must come from `job.filer` while the job is disputed. That is what
/// makes it safe for this server to write rows directly instead of going through the web app.

import { keccak256, toHex } from "viem";
import { db } from "./db.js";
import { config } from "./config.js";

export type Terms = {
  title: string;
  description: string;
  criteria: string;
  proofSpec: string;
  category: string;
  /// An optional commitment that turns "is this good?" into "is this the thing?". When the
  /// employer names the exact digest of the deliverable they will accept, a delivery either
  /// matches it or it does not, and no judgment is needed: the escrow can be told to approve on
  /// the spot. Absent, the job behaves exactly as before — and because the key is only included
  /// in the digest when it is present, every job posted before this existed still re-hashes to the
  /// same value.
  expectedProofHash?: `0x${string}`;
};

/// The single definition of how a job's terms become the hash committed on chain. Identical to
/// the web app's `termsDigest`; a mismatch would be visible immediately, because the on-chain
/// value would not reproduce.
export function termsDigest(terms: Terms): `0x${string}` {
  return keccak256(
    toHex(
      JSON.stringify({
        title: terms.title,
        description: terms.description,
        criteria: terms.criteria,
        proofSpec: terms.proofSpec,
        category: terms.category,
        ...(terms.expectedProofHash ? { expectedProofHash: terms.expectedProofHash } : {}),
      }),
    ),
  );
}

export function proofDigest(proof: string): `0x${string}` {
  return keccak256(toHex(proof));
}

/// Everything that re-checks a stored row against the on-chain commitment goes through here, so
/// an optional field can never be dropped by one call site and kept by another — which would make
/// a perfectly good job fail its own hash check.
export function contentDigest(content: {
  title: string;
  description: string;
  criteria: string;
  proofSpec: string;
  category: string;
  expectedProofHash?: string | null;
}): `0x${string}` {
  return termsDigest({
    title: content.title,
    description: content.description,
    criteria: content.criteria,
    proofSpec: content.proofSpec,
    category: content.category,
    ...(content.expectedProofHash ? { expectedProofHash: content.expectedProofHash as `0x${string}` } : {}),
  });
}

/// A reason is hashed the same way a deliverable is: keccak over the text. The contract only ever
/// stores the digest, so this is what makes a complaint verifiable against what was filed.
export const textDigest = proofDigest;

export type JobContent = Terms & {
  jobId: number;
  employer: string;
  termsHash: string;
  createdAt: string;
};

export type JobProof = {
  jobId: number;
  worker: string;
  proof: string;
  proofHash: string;
  createdAt: string;
};

export type DisputeRecord = {
  jobId: number;
  filer: string;
  reason: string;
  reasonHash: string;
  filedAt: string;
};

export type BidPitch = {
  jobId: number;
  bidIndex: number;
  worker: string;
  pitch: string;
  createdAt: string;
};

/// Stored lowercased, because an address is case-insensitive for the chain but not for a text
/// column: a checksummed write and a lowercased read are different strings and the row vanishes.
const escrowScope = config.escrow.toLowerCase();

let ready = false;

/// The web app owns this schema; these statements are the same ones it issues, so whichever
/// process starts first creates the tables and the other finds them.
async function ensureSchema(): Promise<void> {
  if (ready) return;
  const sql = db();

  await sql`
    create table if not exists job_content (
      job_id      bigint primary key,
      title       text not null,
      description text not null,
      criteria    text not null,
      proof_spec  text not null,
      category    text not null,
      employer    text not null,
      terms_hash  text not null,
      escrow      text not null default '',
      expected_proof_hash text,
      created_at  timestamptz not null default now()
    )`;

  await sql`
    create table if not exists bid_pitch (
      job_id     bigint not null,
      bid_index  integer not null,
      worker     text not null,
      pitch      text not null,
      escrow     text not null default '',
      created_at timestamptz not null default now(),
      primary key (job_id, bid_index)
    )`;

  await sql`
    create table if not exists dispute_reason (
      job_id      bigint primary key,
      filer       text not null,
      reason      text not null,
      reason_hash text not null,
      escrow      text not null default '',
      created_at  timestamptz not null default now()
    )`;

  await sql`
    create table if not exists job_proof (
      job_id     bigint primary key,
      worker     text not null,
      proof      text not null,
      proof_hash text not null,
      escrow     text not null default '',
      created_at timestamptz not null default now()
    )`;

  await sql`
    create table if not exists ruling_note (
      job_id     bigint primary key,
      resolver   text not null,
      ruling     text not null,
      note       text not null,
      escrow     text not null default '',
      created_at timestamptz not null default now()
    )`;

  /// Job ids restart at 1 every time the escrow is redeployed, so every table below is scoped by
  /// the escrow that wrote the row. Without it a fresh deployment's job 1 reads the previous
  /// deployment's text, and the feed shows jobs that exist nowhere on chain.
  for (const table of ["job_content", "bid_pitch", "dispute_reason", "job_proof", "ruling_note"]) {
    await sql`alter table ${sql(table)} add column if not exists escrow text not null default ''`;
  }
  await sql`alter table job_content add column if not exists expected_proof_hash text`;

  /// The key has to carry the escrow. `job_id` alone meant a redeploy's job 1 matched the previous
  /// deployment's row, and `do update` rewrote that row's text — a commitment the old chain still
  /// holds. The web app carries this same block; whichever process opens the database first leaves
  /// it in the shape both of them expect. Idempotent: it reads the existing key's width and does
  /// nothing when the key is already composite.
  const jobKeyed: [string, number][] = [
    ["job_content", 2],
    ["dispute_reason", 2],
    ["job_proof", 2],
    ["ruling_note", 2],
    ["bid_pitch", 3],
  ];
  for (const [table, arity] of jobKeyed) {
    const key = table === "bid_pitch" ? "(escrow, job_id, bid_index)" : "(escrow, job_id)";
    await sql.unsafe(`
      do $$
      declare width int;
      begin
        select coalesce(array_length(conkey, 1), 0) into width
        from pg_constraint
        where conrelid = '${table}'::regclass and contype = 'p';
        if coalesce(width, 0) <> ${arity} then
          alter table ${table} drop constraint if exists ${table}_pkey;
          alter table ${table} add primary key ${key};
        end if;
      end $$;
    `);
  }

  ready = true;
}

const iso = (value: Date | string) => new Date(value).toISOString();

export async function getJobContent(jobId: number): Promise<JobContent | null> {
  await ensureSchema();
  const rows = await db()<
    {
      job_id: string | number | bigint;
      title: string;
      description: string;
      criteria: string;
      proof_spec: string;
      category: string;
      employer: string;
      terms_hash: string;
      expected_proof_hash: string | null;
      created_at: Date | string;
    }[]
  >`select * from job_content where job_id = ${jobId} and escrow = ${escrowScope} limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: Number(row.job_id),
    title: row.title,
    description: row.description,
    criteria: row.criteria,
    proofSpec: row.proof_spec,
    category: row.category,
    employer: row.employer,
    termsHash: row.terms_hash,
    ...(row.expected_proof_hash ? { expectedProofHash: row.expected_proof_hash as `0x${string}` } : {}),
    createdAt: iso(row.created_at),
  };
}

export async function saveJobContent(input: JobContent): Promise<void> {
  await ensureSchema();
  /// `do update`, not `do nothing`: a job id reused by a later deployment already has a row, and
  /// the stale text must be replaced rather than silently kept. Overwriting is safe because every
  /// write is verified to hash to the commitment the current job actually carries.
  await db()`
    insert into job_content (job_id, title, description, criteria, proof_spec, category, employer, terms_hash, escrow, expected_proof_hash)
    values (${input.jobId}, ${input.title}, ${input.description}, ${input.criteria}, ${input.proofSpec},
            ${input.category}, ${input.employer}, ${input.termsHash}, ${escrowScope}, ${input.expectedProofHash ?? null})
    on conflict (escrow, job_id) do update
      set title = excluded.title, description = excluded.description, criteria = excluded.criteria,
          proof_spec = excluded.proof_spec, category = excluded.category, employer = excluded.employer,
          terms_hash = excluded.terms_hash, escrow = excluded.escrow,
          expected_proof_hash = excluded.expected_proof_hash, created_at = now()`;
}

export async function getProof(jobId: number): Promise<JobProof | null> {
  await ensureSchema();
  const rows = await db()<
    {
      job_id: string | number | bigint;
      worker: string;
      proof: string;
      proof_hash: string;
      created_at: Date | string;
    }[]
  >`select * from job_proof where job_id = ${jobId} and escrow = ${escrowScope} limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: Number(row.job_id),
    worker: row.worker,
    proof: row.proof,
    proofHash: row.proof_hash,
    createdAt: iso(row.created_at),
  };
}

export async function saveProof(input: {
  jobId: number;
  worker: string;
  proof: string;
  proofHash: string;
}): Promise<void> {
  await ensureSchema();
  await db()`
    insert into job_proof (job_id, worker, proof, proof_hash, escrow)
    values (${input.jobId}, ${input.worker}, ${input.proof}, ${input.proofHash}, ${escrowScope})
    on conflict (escrow, job_id) do update
      set worker = excluded.worker, proof = excluded.proof, proof_hash = excluded.proof_hash,
          escrow = excluded.escrow, created_at = now()`;
}

export async function getDispute(jobId: number): Promise<DisputeRecord | null> {
  await ensureSchema();
  const rows = await db()<
    {
      job_id: string | number | bigint;
      filer: string;
      reason: string;
      reason_hash: string;
      created_at: Date | string;
    }[]
  >`select * from dispute_reason where job_id = ${jobId} and escrow = ${escrowScope} limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    jobId: Number(row.job_id),
    filer: row.filer,
    reason: row.reason,
    reasonHash: row.reason_hash,
    filedAt: iso(row.created_at),
  };
}

export async function saveDispute(input: {
  jobId: number;
  filer: string;
  reason: string;
  reasonHash: string;
}): Promise<void> {
  await ensureSchema();
  await db()`
    insert into dispute_reason (job_id, filer, reason, reason_hash, escrow)
    values (${input.jobId}, ${input.filer}, ${input.reason}, ${input.reasonHash}, ${escrowScope})
    on conflict (escrow, job_id) do update
      set filer = excluded.filer, reason = excluded.reason, reason_hash = excluded.reason_hash,
          escrow = excluded.escrow, created_at = now()`;
}

export async function listPitches(jobId: number): Promise<BidPitch[]> {
  await ensureSchema();
  const rows = await db()<
    { job_id: string | number | bigint; bid_index: number; worker: string; pitch: string; created_at: Date | string }[]
  >`select * from bid_pitch where job_id = ${jobId} and escrow = ${escrowScope} order by bid_index asc`;
  return rows.map((row) => ({
    jobId: Number(row.job_id),
    bidIndex: Number(row.bid_index),
    worker: row.worker,
    pitch: row.pitch,
    createdAt: iso(row.created_at),
  }));
}

export async function savePitch(input: {
  jobId: number;
  bidIndex: number;
  worker: string;
  pitch: string;
}): Promise<void> {
  await ensureSchema();
  await db()`
    insert into bid_pitch (job_id, bid_index, worker, pitch, escrow)
    values (${input.jobId}, ${input.bidIndex}, ${input.worker}, ${input.pitch}, ${escrowScope})
    on conflict (escrow, job_id, bid_index) do update
      set worker = excluded.worker, pitch = excluded.pitch, escrow = excluded.escrow, created_at = now()`;
}

export async function getRulingNote(jobId: number): Promise<{ resolver: string; ruling: string; note: string } | null> {
  await ensureSchema();
  const rows = await db()<{ resolver: string; ruling: string; note: string }[]>`
    select resolver, ruling, note from ruling_note where job_id = ${jobId} and escrow = ${escrowScope} limit 1`;
  const row = rows[0];
  return row ? { resolver: row.resolver, ruling: row.ruling, note: row.note } : null;
}

/// Written by the resolver, read by the two parties. The contract holds only the ruling enum, so
/// this is the only place the reasoning exists.
export async function saveRulingNote(input: {
  jobId: number;
  resolver: string;
  ruling: string;
  note: string;
}): Promise<void> {
  await ensureSchema();
  await db()`
    insert into ruling_note (job_id, resolver, ruling, note, escrow)
    values (${input.jobId}, ${input.resolver}, ${input.ruling}, ${input.note}, ${escrowScope})
    on conflict (escrow, job_id) do update
      set resolver = excluded.resolver, ruling = excluded.ruling, note = excluded.note,
          escrow = excluded.escrow, created_at = now()`;
}
