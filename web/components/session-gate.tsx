"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { shortAddress } from "@/lib/format";
import { useSessionSignIn } from "@/lib/use-sign-in";
import { Button, Panel, Spinner } from "./ui";

type Gate =
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "mismatch"; session: string }
  | { kind: "denied"; reason: string }
  | { kind: "ready"; session: string };

/// Everything behind a signed session goes through here. The wrapped page never runs
/// until <api> has answered 200 for this browser, so nothing is fetched — or rendered —
/// before the wallet has proven which address it holds.
export function SessionGate<T>({
  endpoint,
  canSign = true,
  deniedHint,
  children,
}: {
  endpoint: string;
  canSign?: boolean;
  deniedHint?: string;
  children: (data: T, controls: { reload: () => void; session: string }) => React.ReactNode;
}) {
  const { address, isConnected } = useAccount();
  const { signIn: runSignIn, signing, error } = useSessionSignIn();

  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  const [data, setData] = useState<T | null>(null);

  /// `load` runs again as soon as the wallet reports its address, so two requests are
  /// routinely in flight. Without a sequence guard the older one can land last and
  /// overwrite a good result with a stale "sign in required".
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    const stale = () => seq.current !== id;
    setGate({ kind: "loading" });
    try {
      /// Resolve the session identity before asking for any private data. A cookie
      /// outlives a wallet switch, and a stale one must never fetch on behalf of the
      /// wallet that is connected right now.
      const meRes = await fetch("/api/session/me", { cache: "no-store" });
      if (stale()) return;
      const me = meRes.ok ? ((await meRes.json()) as { address: string | null }).address : null;
      if (stale()) return;

      if (me && address && me.toLowerCase() !== address.toLowerCase()) {
        setData(null);
        setGate({ kind: "mismatch", session: me });
        return;
      }

      if (me && !address) {
        setData(null);
        setGate({ kind: "signin" });
        return;
      }

      const res = await fetch(endpoint, { cache: "no-store" });
      if (stale()) return;

      if (res.status === 401) {
        setData(null);
        setGate({ kind: "signin" });
        return;
      }

      if (res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (stale()) return;
        setData(null);
        setGate({ kind: "denied", reason: body.error ?? "not allowed" });
        return;
      }

      if (!res.ok) {
        setData(null);
        setGate({ kind: "denied", reason: "the server could not read the chain" });
        return;
      }

      const payload = (await res.json()) as T & { session?: string };
      if (stale()) return;

      setData(payload);
      setGate({ kind: "ready", session: payload.session ?? address ?? "" });
    } catch {
      if (!stale()) setGate({ kind: "denied", reason: "the server did not respond" });
    }
  }, [endpoint, address]);

  useEffect(() => {
    load();
  }, [load]);

  async function signIn() {
    const ok = await runSignIn();
    if (ok) await load();
  }

  if (gate.kind === "loading") {
    return (
      <div className="mt-10 border border-line px-6 py-20 text-center">
        <Spinner label="checking session" />
      </div>
    );
  }

  if (gate.kind === "signin") {
    return (
      <Panel className="mt-8 p-6">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">sign in required</div>
        <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-muted">
          {canSign
            ? "This page renders nothing until it knows which wallet you hold. Connect and sign a message — no gas, no transaction, no transfer. The session expires in two hours."
            : deniedHint ?? "Connect an authorised wallet and sign a message to continue."}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isConnected && canSign ? (
            <Button onClick={signIn} disabled={signing}>
              {signing ? "waiting for signature…" : "sign in"}
            </Button>
          ) : (
            <span className="mono text-[11px] text-muted">
              {isConnected ? deniedHint ?? "this wallet has no access" : "connect a wallet first"}
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

  if (gate.kind === "denied") {
    return (
      <div className="mt-8 border border-dashed border-line-2 px-6 py-16 text-center">
        <p className="text-sm text-muted">no access.</p>
        <p className="mono mt-2 text-[10px] text-muted">{gate.reason}</p>
      </div>
    );
  }

  if (gate.kind === "mismatch") {
    return (
      <Panel className="mt-8 p-6">
        <div className="mono text-[10px] uppercase tracking-[0.18em] text-warn">wrong wallet signed in</div>
        <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-muted">
          This browser still holds a session for{" "}
          <span className="mono text-text">{shortAddress(gate.session)}</span>
          {address ? (
            <>
              , but the wallet connected right now is <span className="mono text-text">{shortAddress(address)}</span>
            </>
          ) : null}
          . Nothing is shown until the connected wallet signs for itself — otherwise this page would hand one
          wallet&apos;s private tickets to whoever holds the browser.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isConnected && canSign ? (
            <Button onClick={signIn} disabled={signing}>
              {signing ? "waiting for signature…" : "sign in with the connected wallet"}
            </Button>
          ) : (
            <span className="mono text-[11px] text-muted">connect a wallet first</span>
          )}
          <button
            onClick={async () => {
              await fetch("/api/session", { method: "DELETE" });
              await load();
            }}
            className="mono text-[10px] uppercase tracking-[0.14em] text-muted underline hover:text-accent"
          >
            sign the other wallet out
          </button>
        </div>

        {error ? (
          <div className="mt-4 border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">{error}</div>
        ) : null}
      </Panel>
    );
  }

  return <>{data ? children(data, { reload: load, session: gate.session }) : null}</>;
}
