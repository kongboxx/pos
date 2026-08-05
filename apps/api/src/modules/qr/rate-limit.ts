/**
 * A small fixed-window counter for the endpoints that have no login.
 *
 * KEYED BY TABLE TOKEN, NOT BY IP. Everyone in the shop is behind one router,
 * so an IP-keyed limiter would let one phone stuck in a retry loop lock every
 * other customer out of ordering. The token is also the thing being abused, so
 * it is the thing worth counting.
 *
 * Fixed windows are crude — a caller can spend a whole window's budget at the
 * end of one and again at the start of the next. That is fine here. This is not
 * defending a bank; it is stopping one phone from opening a hundred bills while
 * a human is not looking, and the approval queue is what actually decides
 * whether any of it becomes food.
 *
 * In memory, like the WebSocket hub, because this is one process on a mini-PC
 * in the shop. A shared store would be a moving part with nothing to move.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets — sent as Retry-After on a refusal. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const window = this.windows.get(key);

    if (!window || now >= window.resetAt) {
      // Sweeping here rather than on a timer: the only thing that grows this
      // map is traffic, so the only moment it needs pruning is while traffic
      // is arriving. A shop with 12 tables never gets near it either way.
      this.prune(now);
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (window.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      };
    }

    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forgets every counter. Used by the tests, which are one long burst. */
  reset(): void {
    this.windows.clear();
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
  }
}
