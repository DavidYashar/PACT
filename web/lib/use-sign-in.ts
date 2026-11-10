"use client";

import { useCallback, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

/// The one signing flow, shared by the session gate and any in-page prompt. Proves the
/// wallet's key and swaps the cookie for one bound to that address — no gas, no transfer.
export function useSessionSignIn() {
  const { address } = useAccount();
  const { signMessageAsync, isPending } = useSignMessage();
  const [error, setError] = useState("");

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    setError("");

    try {
      const res = await fetch(`/api/session?address=${address}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "could not start a session");
        return false;
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
        setError(body.error ?? "signature was rejected");
        return false;
      }

      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message.split("\n")[0] : "signing failed");
      return false;
    }
  }, [address, signMessageAsync]);

  return { signIn, signing: isPending, error, address };
}
