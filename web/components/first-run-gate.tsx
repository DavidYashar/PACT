"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useProfile } from "@/lib/names";

/// First visit for a wallet: send it to the account page so it takes a username before it can
/// act. Fires at most once per wallet per tab, so it never becomes a wall you cannot walk away
/// from — reload and you stay where you are.
export function FirstRunGate() {
  const { address, isConnected } = useAccount();
  const { data: profile } = useProfile(address);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isConnected || !address || !profile) return;
    if (profile.registeredAt > 0n) return;
    if (pathname === "/account") return;

    const key = `pact:greeted:${address.toLowerCase()}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");

    router.push("/account");
  }, [isConnected, address, profile, pathname, router]);

  return null;
}
