import { NextResponse } from "next/server";
import { ESCROW_ADDRESS, WIF_ADDRESS } from "@/lib/chain";
import { erc20Abi, pactAbi } from "@/lib/contract";
import { namesDeployBlock } from "@/lib/env-guard";
import { chainClient, currentSession, logClient } from "@/lib/server-chain";

export const dynamic = "force-dynamic";

/// What the treasury has actually taken out.
///
/// The wallet balance cannot answer this. WIF can leave the treasury wallet for reasons the contract
/// knows nothing about — a sweep, a transfer, a second operator — and then "earned − balance −
/// claimable" reports a gap that is not a gap. The `Claimed` events are the only record of what
/// arrived, so the reconciliation is earned = withdrawn + claimable, whatever the wallet has since
/// done with the money.
async function withdrawnTo(treasury: `0x${string}`): Promise<bigint> {
  const logs = await logClient().getContractEvents({
    address: ESCROW_ADDRESS,
    abi: pactAbi,
    eventName: "Claimed",
    args: { account: treasury },
    /// The escrow was deployed in the same minute as the registry, one block later; no event can
    /// exist before this.
    fromBlock: namesDeployBlock() - 1n,
    toBlock: "latest",
  });
  return logs.reduce((sum, log) => sum + (((log.args as { amount?: bigint }).amount ?? 0n) as bigint), 0n);
}

/// Treasury figures. Server-only, and only for the treasury wallet — the same shape as
/// the admin overview: nothing is serialised before the session is checked against the
/// role read straight from the contract.
export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const client = chainClient();

  try {
    const [jobCount, treasury, resolver, escrowBalance] = await Promise.all([
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "jobCount" }),
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "treasury" }),
      client.readContract({ address: ESCROW_ADDRESS, abi: pactAbi, functionName: "resolver" }),
      client.readContract({
        address: WIF_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ESCROW_ADDRESS],
      }),
    ]);

    if ((treasury as string).toLowerCase() !== session.address.toLowerCase()) {
      return NextResponse.json({ error: "not the treasury" }, { status: 403 });
    }

    const [treasuryBalance, treasuryClaimable, withdrawn] = await Promise.all([
      client.readContract({
        address: WIF_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [treasury as `0x${string}`],
      }),
      client.readContract({
        address: ESCROW_ADDRESS,
        abi: pactAbi,
        functionName: "claimable",
        args: [treasury as `0x${string}`],
      }),
      withdrawnTo(treasury as `0x${string}`),
    ]);

    const total = Number(jobCount);
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const jobs = await Promise.all(
      ids.map(async (id) => {
        try {
          return (await client.readContract({
            address: ESCROW_ADDRESS,
            abi: pactAbi,
            functionName: "getJob",
            args: [BigInt(id)],
          })) as unknown as {
            filer: string;
            state: number;
            budget: bigint;
            price: bigint;
            employerEscrow: bigint;
            workerEscrow: bigint;
          };
        } catch {
          return null;
        }
      }),
    );

    const zero = "0x0000000000000000000000000000000000000000";
    let cut = 0n;
    let filingFees = 0n;
    let locked = 0n;
    let openLocked = 0n;
    let settled = 0;
    let disputed = 0;
    let open = 0;
    let cancelled = 0;
    let tickets = 0;

    for (const job of jobs) {
      if (!job) continue;
      const state = Number(job.state);

      /// A non-zero filer means a ticket was raised — that is what charged the fee, and
      /// the fee is 10% of the price whatever the job did afterwards.
      if (job.filer.toLowerCase() !== zero) {
        tickets += 1;
        filingFees += (job.price * 1000n) / 10_000n;
      }

      if (state === 5) {
        settled += 1;
        cut += job.price / 20n;
      }
      if (state === 4) {
        disputed += 1;
        locked += job.employerEscrow + job.workerEscrow;
      }
      if (state === 2 || state === 3) locked += job.employerEscrow + job.workerEscrow;
      if (state === 1) {
        open += 1;
        openLocked += job.budget;
      }
      if (state === 6) cancelled += 1;
    }

    return NextResponse.json({
      session: session.address,
      treasury,
      resolver,
      escrowBalance: (escrowBalance as bigint).toString(),
      treasuryBalance: (treasuryBalance as bigint).toString(),
      treasuryClaimable: (treasuryClaimable as bigint).toString(),
      withdrawn: withdrawn.toString(),
      cut: cut.toString(),
      filingFees: filingFees.toString(),
      earned: (cut + filingFees).toString(),
      locked: locked.toString(),
      openLocked: openLocked.toString(),
      counts: { settled, disputed, open, cancelled, tickets, total },
    });
  } catch (error) {
    console.error("treasury overview failed", error);
    return NextResponse.json({ error: "could not read the chain" }, { status: 502 });
  }
}
