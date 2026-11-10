-- PACT content store.
--
-- This database is NOT the source of truth. Money, state and identity all live in the contract.
-- What lives here is the text that does not fit in a bytes32: the job brief, acceptance criteria,
-- the proof spec, the deliverable, the complaint, and the ruling note.
--
-- Two rules make it trustworthy:
--
--   1. Every row is bound to a terms_hash / proof_hash / reason_hash taken from the chain. Edit the
--      text and the hash stops matching, so the database cannot lie about a job without the chain
--      contradicting it.
--   2. Every key carries the `escrow` address. Job ids restart at 1 whenever the escrow is
--      redeployed, so a key of `job_id` alone makes a new deployment overwrite the previous one's
--      records — texts the old chain still holds commitments to.
--
-- `web/lib/content.ts` applies and migrates this shape at boot, and `mcp/src/content.ts` applies the
-- same shape, so a fresh database is correct whichever service opens it first. Change all three
-- together.

create table if not exists job_content (
  escrow              text not null default '',
  job_id              bigint not null,
  title               text not null,
  description         text not null,
  criteria            text not null,
  proof_spec          text not null,
  category            text not null,
  employer            text not null,
  terms_hash          text not null,
  expected_proof_hash text,
  created_at          timestamptz not null default now(),
  primary key (escrow, job_id)
);

create table if not exists bid_pitch (
  escrow     text not null default '',
  job_id     bigint not null,
  bid_index  integer not null,
  worker     text not null,
  pitch      text not null,
  created_at timestamptz not null default now(),
  primary key (escrow, job_id, bid_index)
);

-- The complaint text behind a ticket. The chain holds only keccak256(reason); this is the readable
-- side, so a resolver can rule on a claim rather than on a hash.
create table if not exists dispute_reason (
  escrow      text not null default '',
  job_id      bigint not null,
  filer       text not null,
  reason      text not null,
  reason_hash text not null,
  created_at  timestamptz not null default now(),
  primary key (escrow, job_id)
);

-- The deliverable. The chain holds only keccak256(proof); rehashing this row must reproduce that
-- value, which is what lets the employer see the work and still trust it.
create table if not exists job_proof (
  escrow     text not null default '',
  job_id     bigint not null,
  worker     text not null,
  proof      text not null,
  proof_hash text not null,
  created_at timestamptz not null default now(),
  primary key (escrow, job_id)
);

-- Why the resolver ruled the way it did. The chain stores only the ruling enum, so the reasoning
-- only exists here. Written by the resolver, readable by the two parties.
create table if not exists ruling_note (
  escrow     text not null default '',
  job_id     bigint not null,
  resolver   text not null,
  ruling     text not null,
  note       text not null,
  created_at timestamptz not null default now(),
  primary key (escrow, job_id)
);

create index if not exists job_content_employer_idx on job_content (employer);
create index if not exists job_content_category_idx on job_content (category);
create index if not exists job_content_escrow_idx on job_content (escrow);
create index if not exists bid_pitch_worker_idx on bid_pitch (worker);

-- Constraints, so the database rejects garbage from any writer — a new route, the MCP server, a
-- migration, or a human at psql. The address and hash columns accept an empty string because rows
-- written before the `escrow` column existed carry `''`; anything non-empty must be well formed.
do $$
begin
  alter table job_content add constraint job_content_job_id check (job_id > 0) not valid;
  alter table job_content add constraint job_content_title check (length(title) between 1 and 200) not valid;
  alter table job_content add constraint job_content_description check (length(description) between 1 and 20000) not valid;
  alter table job_content add constraint job_content_criteria check (length(criteria) between 0 and 20000) not valid;
  alter table job_content add constraint job_content_proof_spec check (length(proof_spec) between 0 and 20000) not valid;
  alter table job_content add constraint job_content_category check (length(category) between 0 and 40) not valid;
  alter table job_content add constraint job_content_employer check (employer = '' or employer ~ '^0x[0-9a-fA-F]{40}$') not valid;
  alter table job_content add constraint job_content_terms_hash check (terms_hash = '' or terms_hash ~ '^0x[0-9a-f]{64}$') not valid;
  alter table job_content add constraint job_content_escrow check (escrow = '' or escrow ~ '^0x[0-9a-fA-F]{40}$') not valid;
  alter table bid_pitch add constraint bid_pitch_pitch check (length(pitch) between 1 and 4000) not valid;
  alter table bid_pitch add constraint bid_pitch_bid_index check (bid_index between 0 and 100000) not valid;
  alter table dispute_reason add constraint dispute_reason_reason check (length(reason) between 1 and 8000) not valid;
  alter table dispute_reason add constraint dispute_reason_hash check (reason_hash ~ '^0x[0-9a-f]{64}$') not valid;
  alter table job_proof add constraint job_proof_proof check (length(proof) between 1 and 20000) not valid;
  alter table job_proof add constraint job_proof_hash check (proof_hash ~ '^0x[0-9a-f]{64}$') not valid;
  alter table ruling_note add constraint ruling_note_ruling check (ruling in ('worker', 'employer')) not valid;
  alter table ruling_note add constraint ruling_note_note check (length(note) between 0 and 4000) not valid;
exception
  when duplicate_object then null;
end $$;

-- Nothing in this file is ever deleted. A settled or cancelled job keeps its row: the contract still
-- holds the terms_hash forever, so dropping the text would leave a verifiable commitment with
-- nothing left to verify against.
