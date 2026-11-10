"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, formatUnits, http, parseUnits } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { robinhood } from "@/lib/chain";
import { friendlyError } from "@/lib/errors";
import { formatWif, WIF_USD } from "@/lib/format";
import {
  ERC20_ABI,
  PERMIT2,
  PERMIT2_ABI,
  POOLS,
  UNIVERSAL_ROUTER,
  encodeSwap,
  quoteExactIn,
  withSlippage,
} from "@/lib/swap";
import { ConnectButton } from "@/components/connect-button";
import { Button, Field, inputClass, Panel, PanelHeader } from "@/components/ui";

/// Reading the pool has nothing to do with the wallet, so it goes through a plain mainnet client
/// rather than the active-chain transport: the quote renders before anyone connects.
const reader = createPublicClient({
  chain: robinhood,
  transport: http(process.env.NEXT_PUBLIC_RPC_URL || undefined),
});

const SLIPPAGE = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 200, label: "2%" },
];

const PRESETS_BUY = ["0.005", "0.01", "0.05", "0.1"];
const PRESETS_SELL = ["1000", "10000", "50000", "100000"];

type Side = "buy" | "sell";

function eth(value: bigint | undefined): string {
  if (value === undefined) return "—";
  const n = Number(formatUnits(value, 18));
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export default function SwapPage() {
  const chainId = useChainId();
  const pool = POOLS[chainId];

  if (!pool) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <Panel>
          <PanelHeader title="swap" note="buy or sell $WIF against the pool the market actually uses" />
          <div className="space-y-3 px-5 py-6 text-sm leading-relaxed text-muted">
            <p>
              There is no $WIF pool on this network. The swap trades against the Uniswap v4 ETH/WIF
              pool on Robinhood Chain (4663), and that pool is the only venue PACT points at.
            </p>
            <p>
              Without that pool there is nothing to trade against and no router to route through, so
              a button here would be a lie. Everything else on PACT works without it.
            </p>
          </div>
        </Panel>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-10">
      <SwapCard pool={pool} />
    </main>
  );
}

function SwapCard({ pool }: { pool: NonNullable<(typeof POOLS)[number]> }) {
  const { address, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const liveChainId = useChainId();

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState(100);

  const [quote, setQuote] = useState<{ amountOut: bigint; forAmount: string; side: Side } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const amountIn = useMemo(() => {
    try {
      const parsed = parseUnits((amount || "0").trim(), 18);
      return parsed > 0n ? parsed : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  /// Debounced so a half-typed number never spends an RPC call.
  useEffect(() => {
    if (amountIn === 0n) {
      setQuote(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }

    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const q = await quoteExactIn(
          reader as unknown as Parameters<typeof quoteExactIn>[0],
          pool,
          side === "buy",
          amountIn,
        );
        if (cancelled) return;
        setQuote({ amountOut: q.amountOut, forAmount: amountIn.toString(), side });
        setQuoteError(null);
      } catch (e) {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(friendlyError(e instanceof Error ? e.message : String(e)));
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amountIn, side, pool]);

  const fresh = quote !== null && quote.side === side && quote.forAmount === amountIn.toString();
  const amountOut = fresh ? quote.amountOut : undefined;
  const amountOutMinimum = amountOut === undefined ? undefined : withSlippage(amountOut, slippageBps);

  const { data: ethBalance } = useBalance({
    address,
    query: { enabled: Boolean(address), refetchInterval: 8_000 },
  });

  const { data: wifBalance, refetch: refetchWif } = useReadContract({
    address: pool.token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 8_000 },
  });

  /// Selling needs two allowances, in this order: the token lets Permit2 move it, then Permit2 lets
  /// the router pull it. Both are read live because an approval only changes by transaction.
  const { data: tokenAllowance, refetch: refetchTokenAllowance } = useReadContract({
    address: pool.token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, PERMIT2] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 6_000 },
  });

  const { data: permitAllowance, refetch: refetchPermit } = useReadContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: address ? [address, pool.token, UNIVERSAL_ROUTER] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 6_000 },
  });

  const tokenAllowed = (tokenAllowance as bigint | undefined) ?? 0n;
  const permit = permitAllowance as readonly [bigint, number, number] | undefined;
  const permitAmount = permit?.[0] ?? 0n;
  const permitExpiry = Number(permit?.[1] ?? 0);

  const needsTokenApproval = side === "sell" && amountIn > tokenAllowed;
  const needsPermitApproval =
    side === "sell" && !needsTokenApproval && (permitAmount < amountIn || permitExpiry <= Math.floor(Date.now() / 1000) + 60);

  const {
    writeContract,
    data: approvalHash,
    isPending: approving,
    error: approvalError,
    reset: resetApproval,
  } = useWriteContract();
  const { isSuccess: approvalLanded } = useWaitForTransactionReceipt({ hash: approvalHash });

  const { sendTransaction, data: swapHash, isPending: sending, error: sendError } = useSendTransaction();
  const { isLoading: confirming, isSuccess: swapLanded } = useWaitForTransactionReceipt({ hash: swapHash });

  useEffect(() => {
    if (approvalLanded) {
      resetApproval();
      void refetchTokenAllowance();
      void refetchPermit();
    }
  }, [approvalLanded, refetchTokenAllowance, refetchPermit, resetApproval]);

  useEffect(() => {
    if (swapLanded) {
      /// The hash is left in place: the link to the receipt is the proof the trade happened, and
      /// clearing it the moment it confirms takes that away from the person who just traded.
      void refetchWif();
    }
  }, [swapLanded, refetchWif]);

  const busy = approving || confirming || sending;
  const balance = side === "buy" ? (ethBalance?.value ?? 0n) : ((wifBalance as bigint | undefined) ?? 0n);
  const short = amountIn > 0n && balance < amountIn;
  const wrongChain = liveChainId !== robinhood.id;

  const sendSwap = useCallback(() => {
    if (amountOutMinimum === undefined || !address) return;
    const tx = encodeSwap({
      pool,
      zeroForOne: side === "buy",
      amountIn,
      amountOutMinimum,
      /// Six minutes. Long enough for a busy moment, short enough that a signature cannot be
      /// replayed at a price nobody looked at.
      deadline: BigInt(Math.floor(Date.now() / 1000) + 360),
    });
    sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  }, [address, amountIn, amountOutMinimum, pool, sendTransaction, side]);

  const ratePerEth =
    amountOut !== undefined && amountOut > 0n ? (side === "buy" ? amountOut : (amountIn * 10n ** 18n) / amountOut) : undefined;

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader
          title="swap $WIF"
          note="Against the Uniswap v4 ETH/WIF pool, where the market is. PACT never holds your tokens: this is one call to the Universal Router, and the output can only go to the wallet that signs."
        />

        <div className="space-y-4 px-5 py-5">
          <div className="flex gap-2">
            {(["buy", "sell"] as const).map((option) => (
              <button
                key={option}
                onClick={() => {
                  setSide(option);
                  /// Each direction has its own sensible size, and carrying "0.01" across a switch
                  /// would mean quoting a hundredth of a WIF.
                  setAmount(option === "buy" ? "0.01" : "10000");
                }}
                className={`mono min-w-0 flex-1 border px-2 py-2 text-[10px] leading-tight uppercase tracking-[0.1em] sm:px-3 sm:text-[11px] sm:tracking-[0.14em] ${
                  side === option
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-line text-muted hover:border-muted/40"
                }`}
              >
                {option === "buy" ? "buy wif with eth" : "sell wif for eth"}
              </button>
            ))}
          </div>

          <Field
            label={side === "buy" ? "you pay, ETH" : "you sell, WIF"}
            hint={
              address
                ? `balance ${side === "buy" ? `${eth(ethBalance?.value)} ETH` : `${formatWif(wifBalance as bigint | undefined)} WIF`}`
                : "connect a wallet to trade. the quote below needs nothing from you."
            }
          >
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0.0"
              className={`${inputClass} mono text-[16px]`}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            {(side === "buy" ? PRESETS_BUY : PRESETS_SELL).map((preset) => (
              <button
                key={preset}
                onClick={() => setAmount(preset)}
                className="mono border border-line px-2.5 py-1 text-[10px] text-muted hover:border-muted/40 hover:text-text"
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="border border-line bg-ink px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted">you receive</span>
              <span className="mono text-[10px] text-muted">
                {quoting
                  ? "quoting…"
                  : amountOutMinimum !== undefined
                    ? `min ${side === "buy" ? `${formatWif(amountOutMinimum)} WIF` : `${eth(amountOutMinimum)} ETH`}`
                    : ""}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
              {amountOut === undefined ? (
                <span className="mono text-[22px] text-muted">—</span>
              ) : side === "buy" ? (
                <>
                  <span className="mono text-[22px] tabular-nums text-text">{formatWif(amountOut)}</span>
                  <span className="mono text-[12px] text-muted">WIF</span>
                  <span className="mono text-[12px] text-muted">
                    · $
                    {(Number(formatUnits(amountOut, 18)) * WIF_USD).toLocaleString("en-US", {
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </>
              ) : (
                <>
                  <span className="mono text-[22px] tabular-nums text-text">{eth(amountOut)}</span>
                  <span className="mono text-[12px] text-muted">ETH</span>
                </>
              )}
            </div>
            {ratePerEth !== undefined ? (
              <p className="mono mt-2 text-[10px] text-muted">
                {formatWif(ratePerEth, { compact: true })} WIF per ETH · the pool&apos;s 1% hook fee is
                already in this number
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted">max slippage</span>
            {SLIPPAGE.map((option) => (
              <button
                key={option.bps}
                onClick={() => setSlippageBps(option.bps)}
                className={`mono border px-2.5 py-1 text-[10px] ${
                  slippageBps === option.bps
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-line text-muted hover:border-muted/40"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {quoteError ? <p className="text-[11px] text-danger">{quoteError}</p> : null}

          {!isConnected ? (
            <div className="pt-1">
              <ConnectButton stretch />
            </div>
          ) : wrongChain ? (
            <Button onClick={() => switchChain({ chainId: robinhood.id })} className="w-full">
              switch to robinhood chain to trade
            </Button>
          ) : short ? (
            <p className="text-[11px] text-warn">
              this wallet holds {side === "buy" ? `${eth(ethBalance?.value)} ETH` : `${formatWif(wifBalance as bigint | undefined)} WIF`},
              less than the amount entered.
            </p>
          ) : needsTokenApproval ? (
            <Button
              onClick={() =>
                writeContract({
                  address: pool.token,
                  abi: ERC20_ABI,
                  functionName: "approve",
                  args: [PERMIT2, amountIn],
                })
              }
              disabled={busy}
              className="w-full"
            >
              {approving ? "waiting for the wallet…" : `approve ${formatWif(amountIn)} WIF`}
            </Button>
          ) : needsPermitApproval ? (
            <Button
              onClick={() =>
                writeContract({
                  address: PERMIT2,
                  abi: PERMIT2_ABI,
                  functionName: "approve",
                  args: [pool.token, UNIVERSAL_ROUTER, amountIn, Math.floor(Date.now() / 1000) + 1800],
                })
              }
              disabled={busy}
              className="w-full"
            >
              {approving ? "waiting for the wallet…" : "allow the router to pull this amount"}
            </Button>
          ) : (
            <Button onClick={sendSwap} disabled={busy || amountOutMinimum === undefined} className="w-full">
              {sending
                ? "waiting for the wallet…"
                : confirming
                  ? "confirming…"
                  : side === "buy"
                    ? "buy wif"
                    : "sell wif"}
            </Button>
          )}

          {approvalError || sendError ? (
            <p className="text-[11px] text-danger">{friendlyError((approvalError ?? sendError)!.message)}</p>
          ) : null}

          {swapHash ? (
            <a
              href={`https://robinhoodchain.blockscout.com/tx/${swapHash}`}
              target="_blank"
              rel="noreferrer"
              className="mono block text-[11px] text-accent underline decoration-accent/40 underline-offset-4"
            >
              {swapLanded ? "swapped — view the transaction" : "sent — view the transaction"}
            </a>
          ) : null}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="what this is" note="the same route an agent uses, so both ends quote the same pool" />
        <div className="space-y-3 px-5 py-5 text-[12px] leading-relaxed text-muted">
          <p>
            The route is fixed: one <span className="mono text-text">V4_SWAP</span> command to the
            Universal Router, exact input, a floor on the output taken from the quote and your
            slippage tolerance, and the proceeds sent to the signer. No parameter can send them
            elsewhere, and no contract of ours is in the path.
          </p>
          <p>
            Selling needs two allowances, and only for the exact amount: the token to Permit2, and
            Permit2 to the router for half an hour. Nothing is left standing afterwards.
          </p>
          <p>
            The 1% pool fee is charged by the pool&apos;s hook and is already inside the quote. It is
            not a PACT fee — PACT takes nothing from a swap.
          </p>
        </div>
      </Panel>
    </div>
  );
}
