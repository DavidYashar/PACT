"use client";

import Link from "next/link";
import { useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { activeChain } from "@/lib/chain";
import { ESCROW_ADDRESS, pactAbi } from "@/lib/contract";
import { shortAddress, formatWif } from "@/lib/format";
import { useClaimable } from "@/lib/hooks";
import { useUnrecorded } from "@/lib/names";
import { ConnectModal } from "./connect-modal";
import { BUTTON_BASE, BUTTON_STYLES } from "./ui";

/// `stretch` makes the controls fill their container and stack, so the dropdown can match the button
/// exactly. The mobile drawer uses it; the header does not.
export function ConnectButton({ stretch = false }: { stretch?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: claimable } = useClaimable(address);
  const { data: unrecorded } = useUnrecorded(address);

  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const { writeContract, data: hash, isPending: claiming } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  const amount = claimable as bigint | undefined;
  const pending = amount !== undefined && amount > 0n;
  /// claim() pays the whole balance in one transfer, so one unrecorded job blocks everything.
  const locked = Number(unrecorded ?? 0) > 0;

  /// Always open the chooser. It also handles the case where no wallet is installed,
  /// which is more useful than a connect button that fails silently.
  function openConnect() {
    setModalOpen(true);
  }

  const claimButton = pending ? (
    locked ? (
      <Link
        href="/account"
        className={`${BUTTON_BASE} border-warn/60 text-warn hover:bg-warn/10 ${stretch ? "w-full" : ""}`}
      >
        record to claim
      </Link>
    ) : (
      <button
        onClick={() => writeContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "claim" })}
        disabled={claiming || confirming}
        className={`${BUTTON_BASE} ${BUTTON_STYLES.primary} ${stretch ? "w-full" : ""}`}
      >
        {claiming || confirming ? "claiming" : `claim ${formatWif(amount, { compact: true })}`}
      </button>
    )
  ) : null;

  const modal = <ConnectModal open={modalOpen} onClose={() => setModalOpen(false)} />;

  if (!isConnected) {
    return (
      <>
        <button
          onClick={openConnect}
          disabled={isPending}
          className={`${BUTTON_BASE} ${BUTTON_STYLES.primary} ${stretch ? "w-full" : ""}`}
        >
          {isPending ? "connecting…" : "connect"}
        </button>
        {modal}
      </>
    );
  }

  if (chainId !== activeChain.id) {
    return (
      <div className={`flex gap-2 ${stretch ? "w-full flex-col items-stretch" : "items-center"}`}>
        {claimButton}
        <button
          onClick={() => switchChain({ chainId: activeChain.id })}
          className={`${BUTTON_BASE} ${BUTTON_STYLES.danger} ${stretch ? "w-full" : ""}`}
        >
          wrong network
        </button>
        {modal}
      </div>
    );
  }

  return (
    <div className={`relative flex gap-2 ${stretch ? "w-full flex-col items-stretch" : "items-center"}`}>
      {claimButton}

      <button
        onClick={() => setMenuOpen((v) => !v)}
        className={`${BUTTON_BASE} ${BUTTON_STYLES.ghost} ${stretch ? "w-full" : ""}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        {shortAddress(address)}
      </button>

      {menuOpen ? <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} role="presentation" /> : null}

      {/* Kept mounted so it can fade and settle instead of appearing in one frame. `inert` keeps it
          out of the tab order while it is invisible, which `pointer-events` alone does not do. */}
      <div
        inert={!menuOpen}
        aria-hidden={!menuOpen}
        className={`absolute bottom-full z-50 mb-1 origin-bottom border border-line-2 bg-panel p-1 transition duration-150 ease-out sm:top-full sm:bottom-auto sm:mt-1 sm:mb-0 sm:origin-top ${
          stretch ? "left-0 right-0 w-auto" : "right-0 w-48"
        } ${menuOpen ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"}`}
      >
        <Link
              href="/account"
              onClick={() => setMenuOpen(false)}
              className="mono block w-full px-3 py-2 text-left text-[10px] uppercase tracking-[0.1em] text-text transition-colors hover:bg-panel-2"
            >
              my account
            </Link>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(address ?? "");
                setMenuOpen(false);
              }}
              className="mono block w-full px-3 py-2 text-left text-[10px] uppercase tracking-[0.1em] text-muted transition-colors hover:bg-panel-2 hover:text-text"
            >
              copy address
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                setModalOpen(true);
              }}
              className="mono block w-full px-3 py-2 text-left text-[10px] uppercase tracking-[0.1em] text-muted transition-colors hover:bg-panel-2 hover:text-text"
            >
              switch wallet
            </button>
            <button
              onClick={() => {
                disconnect();
                setMenuOpen(false);
              }}
              className="mono block w-full px-3 py-2 text-left text-[10px] uppercase tracking-[0.1em] text-danger transition-colors hover:bg-panel-2"
            >
              disconnect
            </button>
      </div>
    </div>
  );
}
