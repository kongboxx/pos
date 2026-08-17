/**
 * Which Host headers count as the till.
 *
 * Tested as a plain decision rather than through a route, because the thing
 * worth pinning down is the matching — ports, case, missing header — and going
 * through HTTP for each case would bury it.
 */

import { describe, expect, it } from 'vitest';
import { isTillHost } from './host-guard.js';

describe('isTillHost', () => {
  it('lets everything through when no hosts are configured', () => {
    // Dev: both apps talk to localhost:3001, so there is no Host that could
    // tell them apart. Configuring nothing has to mean "not enforced", not
    // "enforced and nothing matches" — the second locks the till out of its
    // own login screen the moment someone forgets the variable.
    expect(isTillHost([], 'anything.example.com')).toBe(true);
    expect(isTillHost([], undefined)).toBe(true);
  });

  it('matches the configured host', () => {
    expect(isTillHost(['shop.example.com'], 'shop.example.com')).toBe(true);
  });

  it('refuses the office host', () => {
    expect(isTillHost(['shop.example.com'], 'office.example.com')).toBe(false);
  });

  it('ignores the port, because a Host header may carry one', () => {
    expect(isTillHost(['shop.example.com'], 'shop.example.com:443')).toBe(true);
  });

  it('is case-insensitive, because host names are', () => {
    expect(isTillHost(['shop.example.com'], 'SHOP.Example.COM')).toBe(true);
  });

  it('refuses a missing Host once hosts are configured', () => {
    expect(isTillHost(['shop.example.com'], undefined)).toBe(false);
  });

  it('does not match a suffix', () => {
    // "evil-shop.example.com" ends with the configured host and must not pass.
    expect(isTillHost(['shop.example.com'], 'evil-shop.example.com')).toBe(false);
    expect(isTillHost(['shop.example.com'], 'shop.example.com.evil.test')).toBe(false);
  });

  it('accepts any of several hosts', () => {
    const hosts = ['shop.example.com', 'till.example.com'];
    expect(isTillHost(hosts, 'till.example.com')).toBe(true);
    expect(isTillHost(hosts, 'office.example.com')).toBe(false);
  });
});
