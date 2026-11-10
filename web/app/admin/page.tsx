"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ESCROW_ADDRESS, STATE_LABEL, pactAbi } from "@/lib/contract";
import { formatWif, formatUsd, shortAddress } from "@/lib/format";
import { addressUrl } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import { useIsAdmin } from "@/lib/admin";
import { Badge, Button, Empty, Field, Panel, Spinner, StateBadge, inputClass } from "@/components/ui";

type JobRow = {
  id: number;
  job: {
    employer: string;
    worker: string;
    state: number;
    budget: string;
    price: string;
    bond: string;
    employerEscrow: string;
    workerEscrow: string;
  };
};

type Overview = {
  session: string;
  treasury: string;
  resolver: string;
  escrowBalance: string;
  treasuryClaimable: string;
  resolverClaimable: string;
  pots: { openLocked: string; frozen: string; unclaimed: string };
  jobs: JobRow[];
};

type Status = "loading" | "denied" | "signin" | "ready";

export default function AdminPage() {
  const { address, isConnected } = useAccount();
  const { isAdmin } = useIsAdmin(address);
  const { signMessageAsync, isPending: signing } = useSignMessage();

  const [status, setStatus] = useState<Status>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reason, setReason] = useState<string>("");
  const [signError, setSignError] = useState<string>("");

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  /// The only call that can return data. 401 means no valid signature yet.
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch("/api/admin/overview", { cache: "no-store" });
      if (res.status === 401) {
        setOverview(null);
        setStatus("signin");
        return;
      }
      if (res.status === 403) {
        setReason("this wallet is not an operator");
        setStatus("denied");
        return;
      }
      if (!res.ok) {
        setReason("the server could not read the chain");
        setStatus("denied");
        return;
      }
      setOverview((await res.json()) as Overview);
      setStatus("ready");
    } catch {
      setReason("the server did not respond");
      setStatus("denied");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function signIn() {
    if (!address) return;
    setSignError("");
    try {
      const res = await fetch(`/api/session?address=${address}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSignError(body.error ?? "could not start a session");
        return;
      }

      const { message } = (await res.json()) as { message: string };
      const signature = await signMessageAsync({ message });

      const verify = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });

      if (!verify.ok) {
        const body = (await verify.json().catch(() => ({}))) as { error?: string };
        setSignError(body.error ?? "signature was rejected");
        return;
      }

      await load();
    } catch (err) {
      setSignError(err instanceof Error ? err.message.split("\n")[0] : "signing failed");
    }
  }

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" });
    setOverview(null);
    setStatus("signin");
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.18em] text-accent">operator</div>
          <h1 className="mt-2 text-2xl tracking-[-0.01em]">admin</h1>
        </div>

        {status === "ready" ? (
          <div className="flex items-center gap-3">
            <span className="mono text-[10px] text-muted">signed in as {shortAddress(overview?.session)}</span>
            <button
              onClick={signOut}
              className="mono border border-line-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-text/40 hover:text-text"
            >
              sign out
            </button>
          </div>
        ) : null}
      </div>

      {status === "loading" ? (
        <div className="mt-10 border border-line px-6 py-20 text-center">
          <Spinner label="checking session" />
        </div>
      ) : null}

      {status === "signin" ? (
        <SignInCard
          isConnected={isConnected}
          address={address}
          signing={signing}
          error={signError}
          onSign={signIn}
          canSign={isAdmin}
        />
      ) : null}

      {status === "denied" ? (
        <div className="mt-8">
          <Empty>
            <p>no access.</p>
            {reason ? <p className="mono mt-2 text-[10px] text-muted">{reason}</p> : null}
          </Empty>
        </div>
      ) : null}

      {status === "ready" ? <Diagnostics /> : null}

      {status === "ready" && overview ? (
        <Overview
          data={overview}
          connected={address}
          onClaim={() => writeContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "claim" })}
          claimBusy={isPending || confirming}
          claimDone={isSuccess}
          claimError={error?.message.split("\n")[0]}
          clearError={reset}
          reload={load}
        />
      ) : null}
    </div>
  );
}

function SignInCard({
  isConnected,
  address,
  signing,
  error,
  onSign,
  canSign,
}: {
  isConnected: boolean;
  address?: `0x${string}`;
  signing: boolean;
  error: string;
  onSign: () => void;
  canSign: boolean;
}) {
  return (
    <Panel className="mt-8 p-6">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">sign in required</div>
      <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-muted">
        This page renders nothing until an operator proves which wallet they hold. Connect the treasury or
        resolver wallet and sign a message — no gas, no transaction, no transfer. The server verifies the
        signature and issues a session that expires in two hours.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {isConnected && canSign ? (
          <Button onClick={onSign} disabled={signing}>
            {signing ? "waiting for signature…" : "sign in as operator"}
          </Button>
        ) : (
          <span className="mono text-[11px] text-muted">
            {isConnected ? "this wallet is not an operator" : "connect a wallet first"}
          </span>
        )}

        {address ? <span className="mono text-[10px] text-muted">connected: {shortAddress(address)}</span> : null}
      </div>

      {error ? (
        <div className="mt-4 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">{error}</div>
      ) : null}
    </Panel>
  );
}

type Health = { status?: string; [key: string]: unknown };

type DiagnosticsReport = {
  ok: boolean;
  chain: Health;
  database: Health;
  mcp: Health;
  configuration: Record<string, string | number>;
};

/// Is each part of the deployment actually up? The chain, the database this process writes to, and
/// the MCP service — which is a different process and therefore a different thing to be wrong.
/// Nothing here is inferred: every row is a measurement taken when the panel loaded.
function Diagnostics() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/diagnostics", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `http ${res.status}`);
      setReport(body as DiagnosticsReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tone = (status?: string) =>
    status === "ok" ? "text-accent" : status === "not configured" || status === "absent" ? "text-muted" : "text-danger";

  return (
    <Panel className="mt-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[13px] font-medium text-text">diagnostics</h2>
          <p className="mt-1.5 max-w-xl text-[11px] leading-relaxed text-muted">
            chain, database and the agent surface, measured now. a failed part is a failed deployment,
            not a slow page.
          </p>
        </div>
        <Button variant="ghost" onClick={() => void load()}>
          re-check
        </Button>
      </div>

      {error ? <p className="px-5 py-4 text-[12px] text-danger">{error}</p> : null}

      {!report && !error ? (
        <div className="px-5 py-6">
          <Spinner label="measuring" />
        </div>
      ) : null}

      {report ? (
        <div className="divide-y divide-line">
          {(
            [
              ["chain", report.chain],
              ["database", report.database],
              ["mcp", report.mcp],
            ] as [string, Health][]
          ).map(([name, health]) => (
            <div key={name} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
              <span className="mono text-[11px] uppercase tracking-[0.12em] text-muted">{name}</span>
              <span className={`mono text-[12px] ${tone(health.status)}`}>
                {health.status ?? "unknown"}
                {typeof health.latencyMs === "number" ? ` · ${health.latencyMs}ms` : ""}
                {typeof health.head === "string" ? ` · head ${health.head}` : ""}
                {health.error ? ` · ${String(health.error).slice(0, 90)}` : ""}
                {health.tables ? ` · ${Object.entries(health.tables as Record<string, number>).map(([t, n]) => `${t} ${n}`).join(", ")}` : ""}
              </span>
            </div>
          ))}
          <div className="px-5 py-3">
            <div className="mono text-[10px] uppercase tracking-[0.12em] text-muted">configuration</div>
            <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(report.configuration).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-3 text-[11px]">
                  <dt className="mono text-muted">{key}</dt>
                  <dd className={`mono break-all ${String(value) === "MISSING" ? "text-danger" : "text-text"}`}>
                    {String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function Overview({
  data,
  connected,
  onClaim,
  claimBusy,
  claimDone,
  claimError,
  clearError,
  reload,
}: {
  data: Overview;
  connected?: `0x${string}`;
  onClaim: () => void;
  claimBusy: boolean;
  claimDone: boolean;
  claimError?: string;
  clearError: () => void;
  reload: () => void;
}) {
  const escrow = BigInt(data.escrowBalance);
  const treasuryClaimable = BigInt(data.treasuryClaimable);
  const resolverClaimable = BigInt(data.resolverClaimable);

  const totals = data.jobs.reduce(
    (acc, { job }) => {
      const price = BigInt(job.price || job.budget);
      if (job.state === 5) {
        acc.settled += 1;
        acc.volume += price;
        acc.fees += price / 20n;
      }
      if (job.state === 2 || job.state === 3) acc.active += 1;
      if (job.state === 4) acc.disputed += 1;
      if (job.state === 1) acc.open += 1;
      return acc;
    },
    { settled: 0, volume: 0n, fees: 0n, active: 0, disputed: 0, open: 0 },
  );

  const isTreasury = connected?.toLowerCase() === data.treasury.toLowerCase();
  const sessionIsTreasury = data.session.toLowerCase() === data.treasury.toLowerCase();
  const claimableNow = isTreasury ? treasuryClaimable : data.session.toLowerCase() === data.resolver.toLowerCase() ? resolverClaimable : 0n;

  return (
    <>
      <Panel className="mt-7">
        <div className="grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-4">
          <Cell
            label="contract holds"
            value={formatWif(escrow, { compact: true })}
            sub="total WIF at the escrow address"
            accent
          />
          <Cell label="fees earned" value={formatWif(totals.fees, { compact: true })} sub={formatUsd(totals.fees)} />
          <Cell label="settled volume" value={formatWif(totals.volume, { compact: true })} sub={`${totals.settled} jobs`} />
          <Cell
            label="live jobs"
            value={totals.active + totals.open + totals.disputed}
            sub={`${totals.open} open · ${totals.disputed} disputed`}
          />
        </div>

        <div className="border-b border-line px-5 py-4">
          <div className="mono text-[9px] uppercase tracking-[0.16em] text-muted">
            where that balance actually is
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Pot
              label="locked in open jobs"
              amount={BigInt(data.pots.openLocked)}
              hint="the employer can cancel and take it back"
            />
            <Pot
              label="frozen by an open ticket"
              amount={BigInt(data.pots.frozen)}
              hint="released only when the resolver rules"
            />
            <Pot
              label="won but not yet claimed"
              amount={BigInt(data.pots.unclaimed)}
              hint="settled — the money is sitting on claim()"
            />
          </div>
        </div>

        <div className="grid gap-px bg-line sm:grid-cols-2">
          <Wallet label="treasury" value={data.treasury} claimable={treasuryClaimable} />
          <Wallet label="resolver" value={data.resolver} claimable={resolverClaimable} />
        </div>
      </Panel>

      <Panel className="mt-5 p-5">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">what &ldquo;contract holds&rdquo; means</div>
        <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">
          It is the WIF token balance of the escrow contract — every coin currently sitting at{" "}
          <span className="mono text-text">{shortAddress(ESCROW_ADDRESS)}</span>. It is not the platform&apos;s
          money and not all of it is live work: settlement never pushes tokens, it only credits a balance, so
          anything already won keeps sitting here until its owner calls{" "}
          <span className="mono text-text">claim()</span>. The three numbers above always add up to it — if they
          ever do not, there is a bug in the contract.
        </p>
      </Panel>

      <Panel className="mt-5 p-5">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">withdrawals</div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          <span className="mono text-text">claim()</span> only ever pays the caller what their own address has
          accrued. The session was started with {shortAddress(data.session)}, so that is the balance this button
          can move.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={onClaim} disabled={claimBusy || claimableNow === 0n}>
            {claimBusy
              ? "claiming…"
              : claimableNow === 0n
                ? "nothing to claim for this session"
                : `claim ${formatWif(claimableNow)} WIF`}
          </Button>

          <span className="mono text-[10px] text-muted">
            {connected && connected.toLowerCase() !== data.session.toLowerCase()
              ? "connected wallet differs from the signed-in address — switch wallets first"
              : sessionIsTreasury
                ? "treasury session"
                : "resolver session"}
          </span>
        </div>

        {claimDone ? (
          <div className="mono mt-3 flex items-center gap-3 border border-accent/30 bg-accent/[0.05] p-3 text-[10px] text-accent">
            claimed.
            <button onClick={reload} className="underline">
              refresh balances
            </button>
          </div>
        ) : null}

        {claimError ? (
          <div className="mt-3 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
            {claimError}
            <button onClick={clearError} className="ml-2 underline">
              dismiss
            </button>
          </div>
        ) : null}
      </Panel>

      <ResolverRole resolver={data.resolver} session={data.session} reload={reload} />

      <section className="mt-10">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="mono text-[11px] uppercase tracking-[0.18em] text-muted">all jobs</h2>
          <span className="mono text-[10px] text-muted">{data.jobs.length} total</span>
        </div>

        {data.jobs.length === 0 ? (
          <Empty>no jobs yet.</Empty>
        ) : (
          <Panel>
            <div className="mono hidden grid-cols-[64px_120px_120px_110px_1fr] gap-3 border-b border-line px-4 py-2 text-[9px] uppercase tracking-[0.14em] text-muted sm:grid">
              <span>job</span>
              <span className="text-right">price</span>
              <span className="text-right">bond</span>
              <span className="text-right">state</span>
              <span className="text-right">employer</span>
            </div>
            <div className="divide-y divide-line">
              {data.jobs
                .slice()
                .sort((a, b) => b.id - a.id)
                .map(({ id, job }) => (
                  <Link
                    key={id}
                    href={`/job/${id}`}
                    className="mono grid grid-cols-2 gap-2 px-4 py-3 text-[11px] transition-colors hover:bg-panel-2 sm:grid-cols-[64px_120px_120px_110px_1fr] sm:items-center sm:gap-3"
                  >
                    <span className="text-muted">#{id}</span>
                    <span className="text-right text-accent">{formatWif(BigInt(job.price || job.budget))}</span>
                    <span className="text-right text-muted">{formatWif(BigInt(job.bond))}</span>
                    <span className="flex justify-end">
                      <StateBadge state={job.state} label={STATE_LABEL[job.state] ?? "—"} />
                    </span>
                    <span className="text-right text-muted">{shortAddress(job.employer)}</span>
                  </Link>
                ))}
            </div>
          </Panel>
        )}
      </section>
    </>
  );
}

/// A resolver that is a party to a job cannot rule on it, so a wallet that both posts
/// jobs and judges them strands its own tickets. This is the way out of that state.
function ResolverRole({ resolver, session, reload }: { resolver: string; session: string; reload: () => void }) {
  const [next, setNext] = useState("");
  const { writeContract, data: hash, isPending, isSuccess, error, reset } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  const sessionIsResolver = session.toLowerCase() === resolver.toLowerCase();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(next) && next.toLowerCase() !== resolver.toLowerCase();

  return (
    <Panel className="mt-5 p-5">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">resolver role</div>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        The current resolver is <span className="mono text-text">{shortAddress(resolver)}</span>. The contract
        refuses a ruling from a resolver that is a party to the job — <span className="mono">ResolverIsParty</span>{" "}
        — so a wallet that both posts jobs and judges them cannot decide its own tickets. Hand the role to a wallet
        that never trades on PACT. It cannot reach escrow: a ruling has no recipient parameter.
      </p>

      {sessionIsResolver ? (
        <>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="hand the role to">
                <input
                  className={inputClass}
                  value={next}
                  onChange={(e) => setNext(e.target.value.trim())}
                  placeholder="0x…"
                  spellCheck={false}
                />
              </Field>
            </div>
            <Button
              disabled={!valid || isPending || confirming}
              onClick={() =>
                writeContract({
                  address: ESCROW_ADDRESS,
                  abi: pactAbi,
                  functionName: "transferResolver",
                  args: [next as `0x${string}`],
                })
              }
            >
              {isPending ? "confirm in wallet…" : confirming ? "moving the role…" : "transfer resolver"}
            </Button>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-warn">
            After this lands, this wallet can no longer rule on anything. There is no way back unless the new
            resolver hands it to you again, so make sure the address is right.
          </p>
        </>
      ) : (
        <p className="mt-3 text-[12px] text-muted">
          Only the current resolver can hand the role on. This session is {shortAddress(session)}.
        </p>
      )}

      {isSuccess ? (
        <div className="mono mt-3 flex items-center gap-3 border border-accent/30 bg-accent/[0.05] p-3 text-[10px] text-accent">
          role transferred.
          <button onClick={reload} className="underline">
            refresh
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
          {friendlyError(error.message)}
          <button onClick={reset} className="ml-2 underline">
            dismiss
          </button>
        </div>
      ) : null}
    </Panel>
  );
}

function Pot({ label, amount, hint }: { label: string; amount: bigint; hint: string }) {
  return (
    <div className="bg-panel-2/40 px-3 py-3">
      <div className="mono text-[9px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mono mt-1 text-[13px] text-text">{formatWif(amount)}</div>
      <div className="mono mt-0.5 text-[9px] leading-relaxed text-muted">{hint}</div>
    </div>
  );
}

function Cell({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {  return (
    <div className="flex flex-col gap-1 px-4 py-4">
      <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className={`mono text-lg leading-none ${accent ? "text-accent" : "text-text"}`}>{value}</span>
      {sub ? <span className="mono text-[9px] text-muted">{sub}</span> : null}
    </div>
  );
}

function Wallet({ label, value, claimable }: { label: string; value: string; claimable: bigint }) {
  return (
    <div className="flex items-center justify-between bg-panel px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</span>
        <a
          href={addressUrl(value)}
          target="_blank"
          rel="noreferrer"
          className="mono text-[11px] text-text hover:text-accent"
        >
          {shortAddress(value)}
        </a>
      </div>
      <div className="flex items-center gap-2">
        <span className={`mono text-[11px] ${claimable > 0n ? "text-accent" : "text-muted"}`}>
          {formatWif(claimable)} unclaimed
        </span>
        {claimable > 0n ? <Badge tone="accent">ready</Badge> : null}
      </div>
    </div>
  );
}
