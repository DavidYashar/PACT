/// Rate limiting, in process.
///
/// The MCP is public, unauthenticated for reads, and its `pact_plan` supersedes a wallet's live
/// intent. On a public URL that is griefing for free: anyone can keep replacing an agent's plan so
/// its carefully signed transaction is no longer the live one. Two limits cover it — requests per
/// IP, and how often one address may have its intent replaced.
///
/// In-process on purpose. It is exact for the single instance this runs on, and it does not pretend
/// to be distributed: behind two instances the effective rate doubles. Moving to Redis later is a
/// change of store, not of policy.

export type LimiterOptions = {
  /// Requests allowed per window, per key.
  limit: number;
  windowMs: number;
};

type Bucket = { count: number; windowStart: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweepThreshold: number;

  constructor(
    private readonly options: LimiterOptions,
    /// Keep the map from growing without bound; a swept entry only ever forgets an old window.
    sweepThreshold = 5_000,
  ) {
    this.sweepThreshold = sweepThreshold;
  }

  /// Records a hit and reports whether it is allowed. `now` is injectable so a test can move time.
  take(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    if (this.buckets.size > this.sweepThreshold) this.sweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.options.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: this.options.limit - 1, retryAfterMs: 0 };
    }

    if (bucket.count >= this.options.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: this.options.windowMs - (now - bucket.windowStart),
      };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.options.limit - bucket.count, retryAfterMs: 0 };
  }

  /// For a cooldown that is not a rate: one action per key per interval, regardless of volume.
  /// Returns false when the key acted too recently.
  cooldown(key: string, intervalMs: number, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const last = this.buckets.get(`cooldown:${key}`);
    if (last && now - last.windowStart < intervalMs) {
      return { allowed: false, retryAfterMs: intervalMs - (now - last.windowStart) };
    }
    this.buckets.set(`cooldown:${key}`, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }

  private sweep(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.options.windowMs) this.buckets.delete(key);
    }
  }
}

/// The IP a request came from. A proxied deployment puts the real client in `x-forwarded-for`, whose
/// first entry is the client; anything that is not a header falls back to the socket address.
export function clientIp(headers: Headers, fallback = "unknown"): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || fallback;
}
