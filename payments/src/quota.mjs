// Bounded in-memory token buckets for abuse limiting on session-creation routes.
// Single-instance only; a multi-instance deployment needs a shared limiter.

export class MemoryTokenBuckets {
  constructor({ now = () => performance.now(), maxKeys = 5000, idleMs = 600000 } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000000 || !Number.isInteger(idleMs) || idleMs < 1000 || idleMs > 86400000) {
      throw new Error('invalid quota store configuration');
    }
    this.now = now; this.maxKeys = maxKeys; this.idleMs = idleMs; this.buckets = new Map();
  }

  clock() {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error('invalid quota clock');
    return value;
  }

  cleanup(now = this.clock()) {
    for (const [key, bucket] of this.buckets) if (Math.max(0, now - bucket.seen) >= this.idleMs) this.buckets.delete(key);
  }

  /** rate is tokens per second; burst is the integer bucket capacity. */
  take(key, { rate, burst }) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256 || !Number.isFinite(rate) || rate <= 0 || rate > 1000 || !Number.isInteger(burst) || burst < 1 || burst > 10000) {
      throw new Error('invalid quota input');
    }
    const now = this.clock();
    this.cleanup(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) return { ok: false, overflow: true, retryAfter: 1 };
      bucket = { tokens: burst, last: now, seen: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed * rate) / 1000);
    if (now > bucket.last) bucket.last = now;
    if (now > bucket.seen) bucket.seen = now;
    if (bucket.tokens < 1) return { ok: false, overflow: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / rate)) };
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }
}
