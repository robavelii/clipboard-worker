/**
 * The rate-limit bindings (STRICT_LIMIT, UNAUTH_LIMIT), in memory.
 *
 * A fixed window per key, with the limit and period wrangler.jsonc gives the
 * Cloudflare binding. Cloudflare's limiter is itself approximate and per
 * location; this one is exact for the one process there is. State is lost on
 * restart, which only ever errs towards allowing.
 */

export class MemoryRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly limitPerPeriod: number,
    private readonly periodSeconds: number,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), periodSeconds * 1000);
    this.sweeper.unref();
  }

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.periodSeconds * 1000 };
      this.windows.set(key, window);
    }
    window.count++;
    return { success: window.count <= this.limitPerPeriod };
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
