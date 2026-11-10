"use client";

import Link from "next/link";
import { Panel, SectionLabel } from "@/components/ui";

/// Shown in place of any action a wallet is not yet allowed to take. A username is permanent
/// and is what ties the points to the address, so nothing that produces a record can happen
/// before one exists.
export function UsernameRequired({ what }: { what: string }) {
  return (
    <Panel className="mt-5 p-5">
      <SectionLabel>choose a username first</SectionLabel>
      <p className="mt-3 text-[13px] text-muted">
        This wallet has no username yet, so it cannot {what}. The name is permanent and is what
        your points hang from — one name per wallet, checked against the registry before it is
        accepted.
      </p>
      <Link
        href="/account"
        className="mono mt-4 inline-block border border-accent bg-accent px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-[#08090a] transition-opacity hover:opacity-90"
      >
        choose your username
      </Link>
    </Panel>
  );
}
