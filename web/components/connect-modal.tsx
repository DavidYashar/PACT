"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useConnect, useConnectors } from "wagmi";
import { activeChain } from "@/lib/chain";

/// A plain modal over wagmi's EIP-6963 discovery. Every installed wallet announces
/// itself with a name and an icon, so this lists whatever the user actually has
/// rather than a hardcoded set that goes stale.
export function ConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectors = useConnectors();
  const { connect, isPending, error, reset } = useConnect();
  const [mounted, setMounted] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  /// wagmi exposes the generic injected connector alongside each announced wallet.
  /// Keep the announced ones — they carry the real name and icon.
  const wallets = useMemo(() => {
    const named = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
    const fallback = connectors.find((c) => c.id === "injected");
    return named.length > 0 ? named : fallback ? [fallback] : [];
  }, [connectors]);

  if (!open || !mounted) return null;

  /// The trigger lives in the sticky header, whose backdrop-filter makes it a
  /// containing block for position:fixed. Portalling to body puts the overlay
  /// back on the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm border border-line-2 bg-panel"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">connect</div>
            <div className="mt-1 text-[15px]">a wallet</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="mono border border-line-2 px-2.5 py-1.5 text-[10px] text-muted transition-colors hover:border-text/40 hover:text-text"
          >
            esc
          </button>
        </div>

        <div className="p-2">
          {!mounted ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">looking for wallets…</div>
          ) : wallets.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-muted">
              No browser wallet detected.
              <br />
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-accent hover:underline"
              >
                install MetaMask →
              </a>
            </div>
          ) : (
            wallets.map((connector) => {
              const busy = isPending && pendingId === connector.id;
              return (
                <button
                  key={connector.id}
                  onClick={() => {
                    setPendingId(connector.id);
                    connect({ connector });
                  }}
                  disabled={isPending}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-panel-2 disabled:opacity-50"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-panel-2">
                    {connector.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={connector.icon} alt="" width={20} height={20} className="h-5 w-5" />
                    ) : (
                      <span className="mono text-[10px] text-muted">{connector.name.slice(0, 2)}</span>
                    )}
                  </span>
                  <span className="flex-1 text-[13px] text-text">{connector.name}</span>
                  <span className="mono text-[10px] uppercase tracking-[0.12em] text-muted">
                    {busy ? "opening…" : "connect"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {error ? (
          <div className="border-t border-danger/40 bg-danger/5 px-4 py-3 text-[11px] leading-relaxed text-danger">
            {error.message.split("\n")[0]}
          </div>
        ) : null}

        <div className="mono flex items-center justify-between border-t border-line px-5 py-3 text-[9px] uppercase tracking-[0.14em] text-muted">
          <span>network</span>
          <span className="text-text">{activeChain.name}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
