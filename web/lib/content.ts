import postgres from "postgres";
import { promises as fs } from "node:fs";
import path from "node:path";

export type JobContent = {
  jobId: number;
  title: string;
  description: string;
  criteria: string;
  proofSpec: string;
  category: string;
  employer: string;
  termsHash: string;
  /// Present only when the employer committed to an exact deliverable digest.
  expectedProofHash?: `0x${string}`;
  createdAt: string;
};

export type BidPitch = {
  jobId: number;
  bidIndex: number;
  worker: string;
  pitch: string;
  createdAt: string;
};

export type DisputeRecord = {
  jobId: number;
  filer: string;
  reason: string;
  reasonHash: string;
  filedAt: string;
};

/// The deliverable itself. The contract only holds keccak256(proof); this is the
/// readable side, verifiable by rehashing and comparing to the on-chain value.
export type JobProof = {
  jobId: number;
  worker: string;
  proof: string;
  proofHash: string;
  createdAt: string;
};

/// Why the resolver ruled the way it did. The contract stores only the ruling enum, so
/// the reasoning lives here — written by the resolver, readable by the two parties.
export type RulingNote = {
  jobId: number;
  resolver: string;
  ruling: "worker" | "employer";
  note: string;
  recordedAt: string;
};

const LOCAL_FILE = path.join(process.cwd(), ".data", "content.json");

type Store = {
  jobs: JobContent[];
  pitches: BidPitch[];
  disputes: DisputeRecord[];
  proofs: JobProof[];
  rulings: RulingNote[];
};

let sql: postgres.Sql | null = null;
let migrated = false;

function db() {
  if (!process.env.DATABASE_URL) {
    /// A live deployment must not write to the filesystem: the disk is ephemeral, so every restart
    /// would erase every published brief and two instances would diverge. Fail at the point of use
    /// rather than answering from a file that will not be there after the next boot.
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production: the content store has no file fallback");
    }
    return null;
  }
  if (!sql) {
    const url = process.env.DATABASE_URL;
    /// Whether TLS is off is a decision about *this* connection, not a substring test on the DSN.
    /// The old regex matched any URL whose userinfo happened to contain `localhost`/`127.0.0.1`,
    /// so a hostname crafted around those words silently downgraded to plaintext.
    let loopback = false;
    try {
      const host = new URL(url).hostname;
      loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    } catch {
      loopback = false;
    }
    const sslSetting = process.env.DATABASE_SSL_MODE === "disable" ? false : loopback ? false : "require";

    sql = postgres(url, {
      ssl: sslSetting,
      max: 3,
      /// A held backend is a denial of service against both services, which share one cluster. A
      /// statement that cannot answer in ten seconds is not going to answer.
      connection: {
        statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT ?? 10_000),
        idle_in_transaction_session_timeout: 30_000,
      },
      /// The schema step is idempotent by design (`create table if not exists`, `add column if not
      /// exists`), and Postgres reports every already-existing object as a NOTICE. Those notices are
      /// the successful case, not a warning, so they are suppressed rather than explained on every
      /// boot. Real errors arrive as exceptions and are still thrown.
      onnotice: () => {},
    });
  }
  return sql;
}

async function ensureSchema() {
  const client = db();
  if (!client || migrated) return client;

  await client`
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

  await client`
    create table if not exists bid_pitch (
      job_id     bigint not null,
      bid_index  integer not null,
      worker     text not null,
      pitch      text not null,
      escrow     text not null default '',
      created_at timestamptz not null default now(),
      primary key (job_id, bid_index)
    )`;

  await client`
    create table if not exists dispute_reason (
      job_id      bigint primary key,
      filer       text not null,
      reason      text not null,
      reason_hash text not null,
      escrow      text not null default '',
      created_at  timestamptz not null default now()
    )`;

  await client`
    create table if not exists job_proof (
      job_id      bigint primary key,
      worker      text not null,
      proof       text not null,
      proof_hash  text not null,
      escrow      text not null default '',
      created_at  timestamptz not null default now()
    )`;

  await client`
    create table if not exists ruling_note (
      job_id     bigint primary key,
      resolver   text not null,
      ruling     text not null,
      note       text not null,
      escrow     text not null default '',
      created_at timestamptz not null default now()
    )`;

  /// Job ids restart at 1 whenever the escrow is redeployed, so rows carry the escrow that wrote
  /// them. Without this the feed lists jobs from a deployment that is no longer on chain.
  for (const table of ["job_content", "bid_pitch", "dispute_reason", "job_proof", "ruling_note"]) {
    await client`alter table ${client(table)} add column if not exists escrow text not null default ''`;
  }
  await client`alter table job_content add column if not exists expected_proof_hash text`;

  /// The key has to carry the escrow too, or a redeploy does not coexist with the previous
  /// deployment's records — it overwrites them. `job_id` was the whole primary key, so the upsert's
  /// conflict target matched a row belonging to a different escrow whenever the ids collided, and
  /// rewrote that row's `escrow` column along with its text. Those texts are commitments the old
  /// chain still holds; losing them means the record of what was agreed is gone.
  ///
  /// Idempotent: the block looks at how many columns the existing key has and does nothing when it
  /// is already the composite one.
  const jobKeyed: [string, number][] = [
    ["job_content", 2],
    ["dispute_reason", 2],
    ["job_proof", 2],
    ["ruling_note", 2],
    ["bid_pitch", 3],
  ];
  for (const [table, arity] of jobKeyed) {
    const key = table === "bid_pitch" ? "(escrow, job_id, bid_index)" : "(escrow, job_id)";
    await client.unsafe(`
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

  /// Constraints, so the database rejects garbage from *any* writer — a new route, the MCP server,
  /// a migration, or a human at psql — instead of trusting every caller to validate first.
  ///
  /// The address and hash columns accept an empty string on purpose: rows written before the
  /// `escrow` column existed carry `''`, and a constraint that cannot be satisfied by legacy data
  /// would block boot instead of fixing anything. Any non-empty value must be well formed, which is
  /// what the audit's `'0xnotanaddress'` and `'notahash'` inserts were not.
  const checks: [string, string, string][] = [
    ["job_content", "job_content_job_id", "job_id > 0"],
    ["job_content", "job_content_title", "length(title) between 1 and 200"],
    ["job_content", "job_content_description", "length(description) between 1 and 20000"],
    ["job_content", "job_content_criteria", "length(criteria) between 0 and 20000"],
    ["job_content", "job_content_proof_spec", "length(proof_spec) between 0 and 20000"],
    ["job_content", "job_content_category", "length(category) between 0 and 40"],
    ["job_content", "job_content_employer", "employer = '' or employer ~ '^0x[0-9a-fA-F]{40}$'"],
    ["job_content", "job_content_terms_hash", "terms_hash = '' or terms_hash ~ '^0x[0-9a-f]{64}$'"],
    ["job_content", "job_content_escrow", "escrow = '' or escrow ~ '^0x[0-9a-fA-F]{40}$'"],
    ["bid_pitch", "bid_pitch_pitch", "length(pitch) between 1 and 4000"],
    ["bid_pitch", "bid_pitch_bid_index", "bid_index between 0 and 100000"],
    ["dispute_reason", "dispute_reason_reason", "length(reason) between 1 and 8000"],
    ["dispute_reason", "dispute_reason_hash", "reason_hash ~ '^0x[0-9a-f]{64}$'"],
    ["job_proof", "job_proof_proof", "length(proof) between 1 and 20000"],
    ["job_proof", "job_proof_hash", "proof_hash ~ '^0x[0-9a-f]{64}$'"],
    ["ruling_note", "ruling_note_ruling", "ruling in ('worker', 'employer')"],
    ["ruling_note", "ruling_note_note", "length(note) between 0 and 4000"],
  ];
  for (const [table, name, expression] of checks) {
    await client.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_constraint where conname = '${name}') then
          alter table ${table} add constraint ${name} check (${expression}) not valid;
        end if;
      end $$;
    `);
  }

  migrated = true;
  return client;
}

async function readLocal(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(LOCAL_FILE, "utf8")) as Partial<Store>;
    return {
      jobs: parsed.jobs ?? [],
      pitches: parsed.pitches ?? [],
      disputes: parsed.disputes ?? [],
      proofs: parsed.proofs ?? [],
      rulings: parsed.rulings ?? [],
    };
  } catch {
    return { jobs: [], pitches: [], disputes: [], proofs: [], rulings: [] };
  }
}

async function writeLocal(store: Store) {
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(store, null, 2));
}

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

/// Row counts per table, for the operator diagnostics panel. Counts and nothing else: the text
/// itself stays private to the parties of each job.
export async function databaseStats(): Promise<Record<string, number>> {
  const client = await ensureSchema();
  if (!client) throw new Error("no database configured");
  const rows = await client<{ table: string; n: number }[]>`
    select 'job_content' as table, count(*)::int as n from job_content
    union all select 'bid_pitch', count(*)::int from bid_pitch
    union all select 'job_proof', count(*)::int from job_proof
    union all select 'dispute_reason', count(*)::int from dispute_reason
    union all select 'ruling_note', count(*)::int from ruling_note`;
  return Object.fromEntries(rows.map((row) => [row.table, row.n]));
}

/// The escrow whose rows this process may see. Job ids restart at 1 on every redeploy, so a
/// row without an escrow is a row from a deployment that is no longer the one being read.
function escrowScope(): string {
  return (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? "").toLowerCase();
}

export async function listJobContent(): Promise<JobContent[]> {
  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, title, description, criteria, proof_spec, category, employer, terms_hash, expected_proof_hash, created_at
      from job_content where escrow = ${escrowScope()} order by job_id desc`;
    return (rows as unknown as ContentRow[]).map(rowToContent);
  }
  const store = await readLocal();
  return store.jobs.sort((a, b) => b.jobId - a.jobId);
}

export async function getJobContent(jobId: number): Promise<JobContent | null> {
  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, title, description, criteria, proof_spec, category, employer, terms_hash, expected_proof_hash, created_at
      from job_content where job_id = ${jobId} and escrow = ${escrowScope()} limit 1`;
    const list = rows as unknown as ContentRow[];
    return list.length ? rowToContent(list[0]) : null;
  }
  const store = await readLocal();
  return store.jobs.find((j) => j.jobId === jobId) ?? null;
}

export async function saveJobContent(input: JobContent): Promise<void> {
  const client = await ensureSchema();
  if (client) {
    /// `do update`, not `do nothing`: the id may be a leftover row from an earlier deployment,
    /// and keeping its text would show one job's brief under another job's settlement.
    await client`
      insert into job_content (job_id, title, description, criteria, proof_spec, category, employer, terms_hash, escrow, expected_proof_hash)
      values (${input.jobId}, ${input.title}, ${input.description}, ${input.criteria}, ${input.proofSpec},
              ${input.category}, ${input.employer}, ${input.termsHash}, ${escrowScope()}, ${input.expectedProofHash ?? null})
      on conflict (escrow, job_id) do update
        set title = excluded.title, description = excluded.description, criteria = excluded.criteria,
            proof_spec = excluded.proof_spec, category = excluded.category, employer = excluded.employer,
            terms_hash = excluded.terms_hash, escrow = excluded.escrow,
            expected_proof_hash = excluded.expected_proof_hash`;
    return;
  }
  const store = await readLocal();
  if (!store.jobs.some((j) => j.jobId === input.jobId)) {
    store.jobs.push({ ...input, createdAt: new Date().toISOString() });
    await writeLocal(store);
  }
}

/// Once a job is inscribed on-chain its text is destroyed on purpose: the contract keeps the
/// two hashes and the settlement facts, and nothing else. The ticket reasoning is kept — it is
/// the audit trail for how the money was decided, not part of the job body.
export async function retireJob(jobId: number): Promise<void> {
  const client = await ensureSchema();
  if (client) {
    await client`delete from job_content where job_id = ${jobId} and escrow = ${escrowScope()}`;
    await client`delete from bid_pitch where job_id = ${jobId} and escrow = ${escrowScope()}`;
    await client`delete from job_proof where job_id = ${jobId} and escrow = ${escrowScope()}`;
    return;
  }
  const store = await readLocal();
  store.jobs = store.jobs.filter((j) => j.jobId !== jobId);
  store.pitches = store.pitches.filter((p) => p.jobId !== jobId);
  store.proofs = store.proofs.filter((p) => p.jobId !== jobId);
  await writeLocal(store);
}

export async function listPitches(jobId: number): Promise<BidPitch[]> {
  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, bid_index, worker, pitch, created_at
      from bid_pitch where job_id = ${jobId} and escrow = ${escrowScope()} order by bid_index asc`;
    return (
      rows as unknown as {
        job_id: string | number | bigint;
        bid_index: number;
        worker: string;
        pitch: string;
        created_at: Date | string;
      }[]
    ).map(rowToPitch);
  }
  const store = await readLocal();
  return store.pitches.filter((p) => p.jobId === jobId).sort((a, b) => a.bidIndex - b.bidIndex);
}

export async function savePitch(input: BidPitch): Promise<void> {
  const client = await ensureSchema();
  if (client) {
    await client`
      insert into bid_pitch (job_id, bid_index, worker, pitch, escrow)
      values (${input.jobId}, ${input.bidIndex}, ${input.worker}, ${input.pitch}, ${escrowScope()})
      on conflict (escrow, job_id, bid_index) do update
        set worker = excluded.worker, pitch = excluded.pitch, escrow = excluded.escrow`;
    return;
  }
  const store = await readLocal();
  if (!store.pitches.some((p) => p.jobId === input.jobId && p.bidIndex === input.bidIndex)) {
    store.pitches.push({ ...input, createdAt: new Date().toISOString() });
    await writeLocal(store);
  }
}

type ContentRow = {
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
};

function rowToContent(r: ContentRow): JobContent {
  return {
    jobId: Number(r.job_id),
    title: r.title,
    description: r.description,
    criteria: r.criteria,
    proofSpec: r.proof_spec,
    category: r.category,
    employer: r.employer,
    termsHash: r.terms_hash,
    ...(r.expected_proof_hash ? { expectedProofHash: r.expected_proof_hash as `0x${string}` } : {}),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToPitch(r: {
  job_id: string | number | bigint;
  bid_index: number;
  worker: string;
  pitch: string;
  created_at: Date | string;
}): BidPitch {
  return {
    jobId: Number(r.job_id),
    bidIndex: Number(r.bid_index),
    worker: r.worker,
    pitch: r.pitch,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listDisputes(): Promise<DisputeRecord[]> {
  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, filer, reason, reason_hash, created_at
      from dispute_reason where escrow = ${escrowScope()} order by job_id desc`;
    return (
      rows as unknown as {
        job_id: string | number | bigint;
        filer: string;
        reason: string;
        reason_hash: string;
        created_at: Date | string;
      }[]
    ).map((r) => ({
      jobId: Number(r.job_id),
      filer: r.filer,
      reason: r.reason,
      reasonHash: r.reason_hash,
      filedAt: new Date(r.created_at).toISOString(),
    }));
  }
  const store = await readLocal();
  return store.disputes.sort((a, b) => b.jobId - a.jobId);
}

export async function saveDispute(input: DisputeRecord): Promise<void> {
  const client = await ensureSchema();
  if (client) {
    await client`
      insert into dispute_reason (job_id, filer, reason, reason_hash, escrow)
      values (${input.jobId}, ${input.filer}, ${input.reason}, ${input.reasonHash}, ${escrowScope()})
      on conflict (escrow, job_id) do update
        set filer = excluded.filer, reason = excluded.reason, reason_hash = excluded.reason_hash,
            escrow = excluded.escrow`;
    return;
  }
  const store = await readLocal();
  if (!store.disputes.some((d) => d.jobId === input.jobId)) {
    store.disputes.push({ ...input, filedAt: new Date().toISOString() });
    await writeLocal(store);
  }
}

export async function listRulings(): Promise<RulingNote[]> {
  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, resolver, ruling, note, created_at
      from ruling_note where escrow = ${escrowScope()} order by job_id desc`;
    return (
      rows as unknown as {
        job_id: string | number | bigint;
        resolver: string;
        ruling: string;
        note: string;
        created_at: Date | string;
      }[]
    ).map((r) => ({
      jobId: Number(r.job_id),
      resolver: r.resolver,
      ruling: r.ruling === "employer" ? "employer" : "worker",
      note: r.note,
      recordedAt: new Date(r.created_at).toISOString(),
    }));
  }
  const store = await readLocal();
  return store.rulings.sort((a, b) => b.jobId - a.jobId);
}

export async function getRuling(jobId: number): Promise<RulingNote | null> {
  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, resolver, ruling, note, created_at
      from ruling_note where job_id = ${jobId} and escrow = ${escrowScope()}`;
    const r = (rows as unknown as {
      job_id: string | number | bigint;
      resolver: string;
      ruling: string;
      note: string;
      created_at: Date | string;
    }[])[0];
    if (!r) return null;
    return {
      jobId: Number(r.job_id),
      resolver: r.resolver,
      ruling: r.ruling === "employer" ? "employer" : "worker",
      note: r.note,
      recordedAt: new Date(r.created_at).toISOString(),
    };
  }
  const store = await readLocal();
  return store.rulings.find((x) => x.jobId === jobId) ?? null;
}

export async function saveRuling(input: RulingNote): Promise<void> {
  const client = await ensureSchema();
  if (client) {
    await client`
      insert into ruling_note (job_id, resolver, ruling, note, escrow)
      values (${input.jobId}, ${input.resolver}, ${input.ruling}, ${input.note}, ${escrowScope()})
      on conflict (escrow, job_id) do update
        set resolver = excluded.resolver, ruling = excluded.ruling, note = excluded.note,
            escrow = excluded.escrow`;
    return;
  }
  const store = await readLocal();
  const existing = store.rulings.find((x) => x.jobId === input.jobId);
  if (existing) {
    existing.ruling = input.ruling;
    existing.note = input.note;
    existing.resolver = input.resolver;
  } else {
    store.rulings.push({ ...input, recordedAt: new Date().toISOString() });
  }
  await writeLocal(store);
}

export async function getProof(jobId: number): Promise<JobProof | null> {  const client = await ensureSchema();
  if (client) {
    const rows = await client`
      select job_id, worker, proof, proof_hash, created_at
      from job_proof where job_id = ${jobId} and escrow = ${escrowScope()} limit 1`;
    const list = rows as unknown as {
      job_id: string | number | bigint;
      worker: string;
      proof: string;
      proof_hash: string;
      created_at: Date | string;
    }[];
    if (!list.length) return null;
    const r = list[0];
    return {
      jobId: Number(r.job_id),
      worker: r.worker,
      proof: r.proof,
      proofHash: r.proof_hash,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  const store = await readLocal();
  return store.proofs.find((p) => p.jobId === jobId) ?? null;
}

export async function saveProof(input: JobProof): Promise<void> {
  const client = await ensureSchema();
  if (client) {
    await client`
      insert into job_proof (job_id, worker, proof, proof_hash, escrow)
      values (${input.jobId}, ${input.worker}, ${input.proof}, ${input.proofHash}, ${escrowScope()})
      on conflict (escrow, job_id) do update
        set worker = excluded.worker, proof = excluded.proof, proof_hash = excluded.proof_hash,
            escrow = excluded.escrow`;
    return;
  }
  const store = await readLocal();
  if (!store.proofs.some((p) => p.jobId === input.jobId)) {
    store.proofs.push({ ...input, createdAt: new Date().toISOString() });
    await writeLocal(store);
  }
}
