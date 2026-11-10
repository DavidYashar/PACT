import { formatUnits, parseUnits } from "viem";

/// Rough USD reference. WIF is a memecoin — this is a display convenience, never a promise.
export const WIF_USD = Number(process.env.NEXT_PUBLIC_WIF_USD ?? "0.00157");

export function formatWif(value: bigint | undefined, opts?: { compact?: boolean }): string {
  if (value === undefined) return "—";
  const n = Number(formatUnits(value, 18));

  if (opts?.compact && n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (opts?.compact && n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;

  /// A number this large is not a balance. A node has answered `balanceOf` with junk in
  /// the high bytes for some wallets, and sixty digits of it is both unreadable and — having no
  /// spaces — wide enough to break a mobile layout. Exponent form keeps it honest and short.
  if (n >= 1e21) return `${n.toExponential(2)}`;

  const text = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  // A loss smaller than a cent rounds to "-0", which reads as a bug rather than as a small loss.
  return text === "-0" ? "0" : text;
}

export function formatUsd(value: bigint | undefined): string {
  if (value === undefined) return "—";
  const usd = Number(formatUnits(value, 18)) * WIF_USD;
  if (usd === 0) return "$0.00";
  // Net figures can be negative — a worker whose bond did not come back, an employer refunded more
  // than they staked — so the threshold has to look at the magnitude or a loss would read "<$0.01".
  const sign = usd < 0 ? "-" : "";
  const magnitude = Math.abs(usd);
  if (magnitude < 0.01) return `${sign}<$0.01`;
  return `${sign}$${magnitude.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function both(value: bigint | undefined): string {
  if (value === undefined) return "—";
  return `${formatWif(value)} WIF · ${formatUsd(value)}`;
}

export function parseWif(value: string): bigint {
  try {
    return parseUnits(value.trim() || "0", 18);
  } catch {
    return 0n;
  }
}

export function shortAddress(address: string | undefined): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function countdown(target: bigint | number | undefined): string {
  if (target === undefined) return "—";
  const t = typeof target === "bigint" ? Number(target) : target;
  const diff = t - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "ended";

  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function toLocalInput(secondsFromNow: number): string {
  const d = new Date(Date.now() + secondsFromNow * 1000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function inputToUnix(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}
