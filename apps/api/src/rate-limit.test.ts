/**
 * The counter in front of the endpoints that have no login.
 *
 * Tested with an injected clock rather than timers: a rate limiter tested with
 * real sleeps is a test that is slow, flaky, and quietly passes when the window
 * arithmetic is wrong by a factor of a thousand.
 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to the limit and then refuses', () => {
    const limiter = new RateLimiter(3, 60_000);
    const at = 1_000_000;

    expect(limiter.check('t', at).allowed).toBe(true);
    expect(limiter.check('t', at).allowed).toBe(true);
    expect(limiter.check('t', at).allowed).toBe(true);
    expect(limiter.check('t', at).allowed).toBe(false);
  });

  it('counts each table separately', () => {
    const limiter = new RateLimiter(1, 60_000);
    const at = 1_000_000;

    expect(limiter.check('table-a', at).allowed).toBe(true);
    // One phone stuck in a retry loop must not stop the next table ordering.
    expect(limiter.check('table-b', at).allowed).toBe(true);
    expect(limiter.check('table-a', at).allowed).toBe(false);
  });

  it('opens up again once the window has passed', () => {
    const limiter = new RateLimiter(1, 60_000);
    const at = 1_000_000;

    expect(limiter.check('t', at).allowed).toBe(true);
    expect(limiter.check('t', at + 59_999).allowed).toBe(false);
    expect(limiter.check('t', at + 60_000).allowed).toBe(true);
  });

  it('says how long to wait, rounded up and never zero', () => {
    const limiter = new RateLimiter(1, 60_000);
    const at = 1_000_000;

    limiter.check('t', at);
    expect(limiter.check('t', at + 30_500).retryAfterSeconds).toBe(30);
    // A refusal with "retry after 0 seconds" reads as "retry now" and produces
    // exactly the loop this is here to stop.
    expect(limiter.check('t', at + 59_999).retryAfterSeconds).toBe(1);
  });
});
