import { NextResponse } from "next/server";
import { ESCROW_ADDRESS } from "@/lib/chain";
import { pactAbi } from "@/lib/contract";
import { chainClient, currentSession, isParty, readJob, readResolver } from "@/lib/server-chain";
import { getJobContent, listRulings } from "@/lib/content";

export const dynamic = "force-dynamic";

const ZERO = "0x0000000000000000000000000000000000000000";

/// The queue. Only tickets this session is entitled to see are ever serialised —
/// a resolver sees every ticket, a party sees only their own.
export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const client = chainClient();

  let total = 0;
  try {
    total = Number(
      await client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "jobCount" }),
    );
  } catch {
    return NextResponse.json({ error: "could not read the chain" }, { status: 502 });
  }

  const resolver = await readResolver();
  const isResolver = Boolean(resolver && resolver.toLowerCase() === session.address.toLowerCase());

  const ids = Array.from({ length: total }, (_, i) => i + 1);
  const jobs = await Promise.all(ids.map((id) => readJob(id)));
  const rulings = await listRulings();
  const rulingFor = (id: number) => rulings.find((r) => r.jobId === id) ?? null;

  const visible = [] as {
    id: number;
    state: number;
    employer: string;
    worker: string;
    filer: string;
    price: string;
    bond: string;
    employerEscrow: string;
    workerEscrow: string;
    title: string | null;
    category: string | null;
    role: "resolver" | "employer" | "worker";
    settledTo: "worker" | "employer" | null;
  }[];

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (!job) continue;

    /// `filer` is only ever set by raiseDispute, so a non-zero filer is what makes a job
    /// a ticket — including after it settles and leaves the open queue.
    if (job.filer.toLowerCase() === ZERO) continue;
    if (job.state !== 4 && job.state !== 5) continue;

    const party = isParty(job, session.address);
    if (!isResolver && !party) continue;

    const content = await getJobContent(index + 1);
    const me = session.address.toLowerCase();

    visible.push({
      id: index + 1,
      state: job.state,
      employer: job.employer,
      worker: job.worker,
      filer: job.filer,
      price: job.price.toString(),
      bond: job.bond.toString(),
      employerEscrow: job.employerEscrow.toString(),
      workerEscrow: job.workerEscrow.toString(),
      title: content?.title ?? null,
      category: content?.category ?? null,
      role: isResolver ? "resolver" : job.employer.toLowerCase() === me ? "employer" : "worker",
      settledTo: job.state === 5 ? (rulingFor(index + 1)?.ruling ?? null) : null,
    });
  }

  return NextResponse.json({
    session: session.address,
    isResolver,
    tickets: visible.sort((a, b) => b.id - a.id),
  });
}
