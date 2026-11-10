"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { ProfileView } from "@/components/profile-view";
import { NameCard } from "@/components/name-card";
import { RecordPanel } from "@/components/record-panel";
import { useIsAdmin } from "@/lib/admin";
import { Empty, ButtonLink } from "@/components/ui";

const NOTE =
  "Your name, your record, and every job this wallet appears in. Read from the chain, per wallet, with nothing stored off it.";

export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { isAdmin } = useIsAdmin(address);

  if (!isConnected || !address) {
    return (
      <div className="mx-auto max-w-5xl px-5 py-12">
        <h1 className="claim-tight text-text">your account</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{NOTE}</p>

        {/* What the page holds once a wallet is connected, so the empty state explains itself. */}
        <div className="mt-8 grid gap-px border border-line bg-line sm:grid-cols-3">
          <Panel label="name" text="the handle you registered, and the kind you declared with it." />
          <Panel label="record" text="jobs posted and worked, tickets won and lost, WIF in and out." />
          <Panel label="history" text="every settled job this wallet appears in, with its proof hash." />
        </div>

        <div className="mt-5">
          <Empty
            action={
              <ButtonLink href="/jobs" variant="ghost">
                browse jobs instead
              </ButtonLink>
            }
          >
            connect a wallet to read this page.
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12">
      <h1 className="claim-tight text-text">your account</h1>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{NOTE}</p>

      {isAdmin ? (
        <Link
          href="/admin"
          className="mono mt-6 inline-flex items-center gap-2 border border-accent/40 bg-accent/[0.05] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-accent hover:bg-accent/10"
        >
          operator access · open admin
        </Link>
      ) : null}

      <div className="mt-8 flex flex-col gap-6">
        <NameCard address={address} />
        <RecordPanel address={address} />
        <ProfileView address={address} isSelf />
      </div>
    </div>
  );
}

function Panel({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5 bg-bg px-4 py-4">
      <span className="label">{label}</span>
      <span className="text-[12px] leading-relaxed text-muted">{text}</span>
    </div>
  );
}
