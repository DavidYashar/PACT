/// Request guards for the route handlers: a body cap and a per-IP rate limit.
///
/// Both exist because the endpoints that write text are the only ones a stranger can reach without a
/// session, and an unbounded body or an unbounded rate is a way to cost the deployment money without
/// attacking anything in particular. The limits are per instance and in memory, which is exact for
/// the single instance this runs on and honest about not being a distributed quota.

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterMs: windowMs - (now - bucket.windowStart) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

/// The client address behind the platform's proxy: `x-forwarded-for` carries it first.
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/// Reads a JSON body with a hard ceiling. Returns a `Response` when the caller must stop, and the
/// parsed value otherwise, so a route reads:
///
///   const body = await readJson<Thing>(request, 32_000);
///   if (body instanceof NextResponse) return body;
///
/// A 413 is the correct answer for an oversized body; without the cap, the failure was a 500 from
/// the database constraint after the whole payload had been buffered.
export class PayloadTooLarge {
  constructor(readonly limit: number) {}
}

export async function readJsonWithLimit<T>(request: Request, limitBytes: number): Promise<T | PayloadTooLarge | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limitBytes) return new PayloadTooLarge(limitBytes);

  const text = await request.text();
  /// A missing or lying `content-length` still gets measured.
  if (Buffer.byteLength(text, "utf8") > limitBytes) return new PayloadTooLarge(limitBytes);

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
