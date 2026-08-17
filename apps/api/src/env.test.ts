import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const VALID = {
  DATABASE_URL: 'postgresql://pos:pos@localhost:5432/pos_dev',
  JWT_SECRET: 'a-sufficiently-long-dev-secret',
  PRINT_AGENT_TOKEN: 'a-sufficiently-long-agent-token',
};

describe('loadEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = loadEnv(VALID);
    expect(env.PORT).toBe(3001);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.NODE_ENV).toBe('development');
    expect(env.WEB_ORIGIN).toEqual(['http://localhost:5173', 'http://localhost:5174']);
  });

  it('coerces PORT from a string', () => {
    expect(loadEnv({ ...VALID, PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails loudly at boot when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = VALID;
    expect(() => loadEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a JWT secret that is too short to be worth anything', () => {
    expect(() => loadEnv({ ...VALID, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a malformed WEB_ORIGIN instead of breaking CORS silently', () => {
    expect(() => loadEnv({ ...VALID, WEB_ORIGIN: 'localhost:5173' })).toThrow(/WEB_ORIGIN/);
  });

  it('accepts several origins so the till and the back office can both reach the API', () => {
    const env = loadEnv({
      ...VALID,
      WEB_ORIGIN: 'https://shop.example.com,https://office.example.com',
    });
    expect(env.WEB_ORIGIN).toEqual(['https://shop.example.com', 'https://office.example.com']);
  });

  it('tolerates spaces around the commas, because a human types this into a .env', () => {
    const env = loadEnv({ ...VALID, WEB_ORIGIN: 'http://a.test , http://b.test' });
    expect(env.WEB_ORIGIN).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects the whole list when ONE entry is malformed', () => {
    // The dangerous failure is the quiet one: a typo in the second origin that
    // leaves CORS working for the till and silently broken for the office.
    expect(() => loadEnv({ ...VALID, WEB_ORIGIN: 'http://a.test,office.example.com' })).toThrow(
      /WEB_ORIGIN/,
    );
  });

  it('rejects an empty WEB_ORIGIN rather than allowing nothing at all', () => {
    expect(() => loadEnv({ ...VALID, WEB_ORIGIN: '  ' })).toThrow(/WEB_ORIGIN/);
  });

  it('refuses to boot without a print agent token', () => {
    // Without it the /print/agent/* routes would accept anyone on the LAN.
    const { PRINT_AGENT_TOKEN: _omitted, ...withoutToken } = VALID;
    expect(() => loadEnv(withoutToken)).toThrow(/PRINT_AGENT_TOKEN/);
    expect(() => loadEnv({ ...VALID, PRINT_AGENT_TOKEN: '1234' })).toThrow(/PRINT_AGENT_TOKEN/);
  });
});
