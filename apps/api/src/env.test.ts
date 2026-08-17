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

  it('leaves TILL_HOSTS empty by default, which means the check does not run', () => {
    expect(loadEnv(VALID).TILL_HOSTS).toEqual([]);
  });

  it('splits TILL_HOSTS the same way as WEB_ORIGIN', () => {
    const env = loadEnv({ ...VALID, TILL_HOSTS: 'shop.example.com , till.example.com' });
    expect(env.TILL_HOSTS).toEqual(['shop.example.com', 'till.example.com']);
  });

  it('refuses to boot without a print agent token', () => {
    // Without it the /print/agent/* routes would accept anyone on the LAN.
    const { PRINT_AGENT_TOKEN: _omitted, ...withoutToken } = VALID;
    expect(() => loadEnv(withoutToken)).toThrow(/PRINT_AGENT_TOKEN/);
    expect(() => loadEnv({ ...VALID, PRINT_AGENT_TOKEN: '1234' })).toThrow(/PRINT_AGENT_TOKEN/);
  });

  it('does not trust proxy headers unless told to', () => {
    expect(loadEnv(VALID).TRUST_PROXY).toBe(false);
  });

  it('trusts one hop when TRUST_PROXY is the string "true"', () => {
    expect(loadEnv({ ...VALID, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
  });

  it('rejects anything other than true or false, instead of quietly meaning true', () => {
    // z.coerce.boolean() would read "false" as true, because every non-empty
    // string is truthy. Getting this backwards turns the per-IP login limiter
    // into a single shared bucket for the whole internet, and nothing says so.
    expect(() => loadEnv({ ...VALID, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});
