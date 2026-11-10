"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { DisputeRecord, JobContent, JobProof } from "./content";

/// Fetches published terms for every job in one request. Content is off-chain; the on-chain
/// termsHash is what binds it to the job, so a tampered description fails verification.
export function useJobContent() {
  const [contents, setContents] = useState<Record<number, JobContent>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const res = await fetch("/api/jobs", { cache: "no-store" });
        const json = (await res.json()) as { jobs: JobContent[] };
        if (!alive) return;
        const map: Record<number, JobContent> = {};
        for (const job of json.jobs ?? []) map[job.jobId] = job;
        setContents(map);
      } catch {
        if (alive) setContents({});
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return { contents, loading };
}

export function useSingleJobContent(jobId: number) {
  const { address } = useAccount();
  const [content, setContent] = useState<JobContent | null>(null);
  const [pitches, setPitches] = useState<{ bidIndex: number; worker: string; pitch: string }[]>([]);
  const [proof, setProof] = useState<JobProof | null>(null);
  const [dispute, setDispute] = useState<DisputeRecord | null>(null);
  const [privileged, setPrivileged] = useState(false);
  const [parties, setParties] = useState<{ employer: string; worker: string; resolver: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!jobId) return;
    let alive = true;

    const load = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        const json = (await res.json()) as {
          content: JobContent | null;
          pitches: { bidIndex: number; worker: string; pitch: string }[];
          proof: JobProof | null;
          dispute: DisputeRecord | null;
          privileged: boolean;
          session: string | null;
          parties: { employer: string; worker: string; resolver: string | null } | null;
        };
        if (!alive) return;
        setContent(json.content ?? null);
        setPitches(json.pitches ?? []);
        /// A cookie outlives a wallet switch: only trust the private fields when the
        /// session the server checked belongs to the wallet connected right now.
        const sameWallet =
          Boolean(json.session) && Boolean(address) && json.session!.toLowerCase() === address!.toLowerCase();
        const trusted = Boolean(json.privileged) && sameWallet;

        setPrivileged(trusted);
        /// Withhold the payload itself, not just the flag — the response may carry it
        /// when the cookie belonged to a different wallet than the one on screen.
        setProof(trusted ? (json.proof ?? null) : null);
        setDispute(trusted ? (json.dispute ?? null) : null);
        setParties(json.parties ?? null);
      } catch {
        if (alive) setContent(null);
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [jobId, tick, address]);

  return { content, pitches, proof, dispute, privileged, parties, loading, reload };
}
