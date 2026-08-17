/**
 * A small fixed-window counter, used by two callers that want opposite keys.
 *
 * THE QR ORDERING PAGE KEYS BY TABLE TOKEN. Everyone in the shop is behind one
 * router, so keying by IP there would let one phone stuck in a retry loop lock
 * every other customer out of ordering. The token is also the thing being
 * abused, so it is the thing worth counting.
 *
 * THE LOGIN ENDPOINTS KEY BY IP, for the mirror-image reason. Keying by account
 * is already done (the lockout columns on Staff) and it cannot see the attack
 * that matters here: one host on the internet working through a list of
 * addresses, one guess each, never tripping any single account's counter.
 *
 * Fixed windows are crude — a caller can spend a whole window's budget at the
 * end of one and again at the start of the next. That is fine for both uses.
 * This is not defending a bank; it is turning "unlimited guesses" into "a few
 * per minute", which is the difference between a weekend and a millennium.
 *
 * In memory, like the WebSocket hub, because this is one process on one box. A
 * shared store would be a moving part with nothing to move. The cost is that a
 * restart forgets every counter, which an attacker cannot cause on demand.
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
