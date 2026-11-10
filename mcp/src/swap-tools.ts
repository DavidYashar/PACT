/// The two swap tools: one that prices a trade and one that prepares it.
///
/// Both are deliberately narrow. `pact_quote_swap` is a pure read. `pact_swap` returns unsigned
/// transactions that the agent signs itself, and the output always goes to the signing wallet —
/// there is no recipient parameter to point somewhere else, which is the same rule the ruling path
/// follows. PACT never takes custody of a token here: the trade is between the wallet and the pool.

import { config, type Address } from "./config.js";
import { client } from "./chain.js";
import {
  PERMIT2,
  PERMIT2_ABI,
  ERC20_ABI,
  UNIVERSAL_ROUTER,
  ROUTER_ABI,
  encodeSwap,
  poolFor,
  quoteExactIn,
  withSlippage,
  type Pool,
} from "./swap.js";

const FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

function noPool(chainId: number) {
  return {
    ok: false as const,
    reason: `there is no WIF pool on chain ${chainId}`,
    fix: "the swap exists on Robinhood Chain mainnet (4663) only; on other chains WIF has no market",
  };
}

function pool(): Pool | { ok: false } {
  try {
    return poolFor(config.chainId);
  } catch {
    return noPool(config.chainId) as unknown as Pool;
  }
}

/// What the pool would do right now, in both directions, for a given size.
export async function quoteSwap(params: { side: "buy" | "sell"; amountIn: string; slippageBps?: number }) {
  const p = pool();
  if (!("key" in p)) return p;

  const amountIn = BigInt(params.amountIn);
  if (amountIn <= 0n) return { ok: false, reason: "amountIn must be greater than zero" };

  const zeroForOne = params.side === "buy";
  const q = await quoteExactIn(client as never, p, zeroForOne, amountIn);
  const slippageBps = params.slippageBps ?? 100;

  /// The rate either way, so an agent can report a price without doing decimal maths badly.
  const inUnit = Number(amountIn) / 1e18;
  const outUnit = Number(q.amountOut) / 1e18;

  return {
    ok: true as const,
    chainId: config.chainId,
    pool: {
      pair: "ETH / WIF",
      fee: p.key.fee,
      tickSpacing: p.key.tickSpacing,
      hooks: p.key.hooks,
      router: UNIVERSAL_ROUTER,
      permit2: PERMIT2,
    },
    side: params.side,
    amountIn: inUnit,
    amountOut: outUnit,
    rate: zeroForOne ? outUnit / inUnit : inUnit / outUnit,
    rateLabel: zeroForOne ? "WIF per ETH" : "ETH per WIF",
    slippageBps,
    amountOutMinimum: withSlippage(q.amountOut, slippageBps).toString(),
    note: "the pool takes a 1% fee on every trade, charged by its hook. The quote already includes it.",
  };
}

export type SwapStep = {
  label: string;
  to: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
};

/// The transactions a swap needs, in order, with only the approvals that are actually missing.
export async function planSwap(params: {
  address: Address;
  side: "buy" | "sell";
  amountIn: string;
  slippageBps?: number;
  deadlineSeconds?: number;
}) {
  const p = pool();
  if (!("key" in p)) return p;

  const amountIn = BigInt(params.amountIn);
  if (amountIn <= 0n) return { ok: false, reason: "amountIn must be greater than zero" };

  const zeroForOne = params.side === "buy";
  const q = await quoteExactIn(client as never, p, zeroForOne, amountIn);
  const slippageBps = params.slippageBps ?? 100;
  const amountOutMinimum = withSlippage(q.amountOut, slippageBps);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + BigInt(params.deadlineSeconds ?? 600);

  const steps: SwapStep[] = [];

  if (!zeroForOne) {
    /// Selling needs two approvals, and only the ones that are not already in place: the token has
    /// to allow Permit2, and Permit2 has to allow the router for this amount and until an expiry.
    const tokenAllowance = (await client.readContract({
      address: p.token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [params.address, PERMIT2],
    })) as bigint;

    if (tokenAllowance < amountIn) {
      steps.push({
        label: `allow Permit2 to move ${Number(amountIn) / 1e18} ${p.symbol}`,
        to: p.token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [PERMIT2, amountIn],
      });
    }

    const [permitAllowance, permitExpiration] = (await client.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [params.address, p.token, UNIVERSAL_ROUTER],
    })) as readonly [bigint, number, number];

    const expired = Number(permitExpiration) <= Number(now);
    if (permitAllowance < amountIn || expired) {
      steps.push({
        label: `allow the router to pull ${Number(amountIn) / 1e18} ${p.symbol} through Permit2`,
        to: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [p.token, UNIVERSAL_ROUTER, amountIn, Number(now) + 1800],
      });
    }
  }

  const tx = encodeSwap({
    pool: p,
    zeroForOne,
    amountIn,
    amountOutMinimum,
    deadline,
  });

  steps.push({
    label: zeroForOne
      ? `buy ${p.symbol} with ${Number(amountIn) / 1e18} ETH, minimum ${FORMAT.format(Number(amountOutMinimum) / 1e18)} ${p.symbol}`
      : `sell ${Number(amountIn) / 1e18} ${p.symbol} for at least ${FORMAT.format(Number(amountOutMinimum) / 1e18)} ETH`,
    /// The parts, not the encoded blob: `verifySignedStep` rebuilds the calldata from these and
    /// compares, so a swap cannot be turned into a different call between planning and signing.
    to: tx.to,
    abi: ROUTER_ABI,
    functionName: "execute",
    args: [tx.commands, tx.inputs, tx.deadline],
    value: tx.value,
  });

  return {
    ok: true as const,
    steps,
    side: params.side,
    amountIn: amountIn.toString(),
    amountOut: q.amountOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    summary:
      `${params.side === "buy" ? "Buy" : "Sell"} through the Uniswap v4 ETH/WIF pool. ` +
      `The output goes to ${params.address} and nowhere else; the route cannot name another recipient. ` +
      `A 1% fee is taken by the pool's hook and is already in the quote.`,
  };
}