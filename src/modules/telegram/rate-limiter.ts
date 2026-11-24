export class InMemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastCleanupAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    if (now - this.lastCleanupAt >= this.windowMs) {
      for (const [userKey, timestamps] of this.hits) {
        const active = timestamps.filter(
          (timestamp) => timestamp > windowStart,
        );
        if (active.length) this.hits.set(userKey, active);
        else this.hits.delete(userKey);
      }
      this.lastCleanupAt = now;
    }
    const prev = this.hits.get(key) ?? [];
    const recent = prev.filter((t) => t > windowStart);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
