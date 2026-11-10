import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ESCROW_ADDRESS, WIF_ADDRESS } from "@/lib/chain";
import { erc20Abi, pactAbi } from "@/lib/contract";
import { SESSION_COOKIE, adminSet, readSession } from "@/lib/session-server";
import { chainClient } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// Everything the admin panel shows comes from here. Requires a signed session *and*
/// that the session address is an operator — the cookie alone is not enough.
export async function GET() {
  const store = await cookies();
  const session = readSession(store.get(SESSION_COOKIE)?.value);

  if (!session) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const admins = await adminSet();
  if (!admins.has(session.address.toLowerCase())) {
    return NextResponse.json({ error: "not an operator" }, { status: 403 });
  }

  const client = chainClient();

  try {
    const [jobCount, escrowBalance, treasury, resolver] = await Promise.all([
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "jobCount" }),
      client.readContract({
        address: WIF_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ESCROW_ADDRESS],
      }),
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "treasury" }),
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "resolver" }),
    ]);

    const total = Number(jobCount);
    const ids = Array.from({ length: total }, (_, i) => i + 1);

    const jobs = await Promise.all(
      ids.map(async (id) => {
        try {
          const job = await client.readContract({
            address: ESCROW_ADDRESS,
            abi: pactAbi,
            functionName: "getJob",
            args: [BigInt(id)],
          });
          return { id, job: serialiseJob(job) };
        } catch {
          return null;
        }
      }),
    );

    const [treasuryClaimable, resolverClaimable] = await Promise.all([
      client
        .readContract({
          address: ESCROW_ADDRESS,
          abi: pactAbi,
          functionName: "claimable",
          args: [treasury as `0x${string}`],
        })
        .catch(() => 0n),
      client
        .readContract({
          address: ESCROW_ADDRESS,
          abi: pactAbi,
          functionName: "claimable",
          args: [resolver as `0x${string}`],
        })
        .catch(() => 0n),
    ]);

    const present = jobs.filter((row): row is NonNullable<typeof row> => Boolean(row));

    return NextResponse.json({
      session: session.address,
      treasury,
      resolver,
      escrowBalance: (escrowBalance as bigint).toString(),
      treasuryClaimable: (treasuryClaimable as bigint).toString(),
      resolverClaimable: (resolverClaimable as bigint).toString(),
      pots: potsFromJobs(present, escrowBalance as bigint),
      jobs: present,
    });
  } catch (error) {
    console.error("admin overview failed", error);
    return NextResponse.json({ error: "could not read the chain" }, { status: 502 });
  }
}

/// BigInts do not survive JSON, and the page only needs a few fields.
/// The escrow's WIF balance is not one number's worth of meaning. It is always exactly
/// three things: budgets still locked in open jobs, escrow frozen by an open ticket, and
/// money already won but not yet claimed. Anything left over would be a contract bug.
function potsFromJobs(
  rows: { id: number; job: { state: number; budget: string; employerEscrow: string; workerEscrow: string } }[],
  balance: bigint,
) {
  let openLocked = 0n;
  let frozen = 0n;

  for (const { job } of rows) {
    const budget = BigInt(job.budget);
    const employerEscrow = BigInt(job.employerEscrow);
    const workerEscrow = BigInt(job.workerEscrow);

    /// An OPEN job holds its budget but has no escrow yet — acceptBid is what moves
    /// budget into employerEscrow.
    if (job.state === 1) openLocked += budget;
    if (job.state === 4) frozen += employerEscrow + workerEscrow;
  }

  const unclaimed = balance - openLocked - frozen;

  return {
    openLocked: openLocked.toString(),
    frozen: frozen.toString(),
    unclaimed: (unclaimed > 0n ? unclaimed : 0n).toString(),
  };
}

function serialiseJob(job: unknown) {  const j = job as {
    employer: string;
    worker: string;
    state: number;
    budget: bigint;
    price: bigint;
    bond: bigint;
    employerEscrow: bigint;
    workerEscrow: bigint;
  };

  return {
    employer: j.employer,
    worker: j.worker,
    state: Number(j.state),
    budget: j.budget.toString(),
    price: j.price.toString(),
    bond: j.bond.toString(),
    employerEscrow: j.employerEscrow.toString(),
    workerEscrow: j.workerEscrow.toString(),
  };
}
