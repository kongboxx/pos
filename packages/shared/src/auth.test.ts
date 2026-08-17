import { describe, expect, it } from 'vitest';
import { officeLoginRequestSchema, passwordSchema, PASSWORD_MIN_LENGTH } from './auth.js';

describe('the office password rules', () => {
  it('demands length and nothing else', () => {
    // NIST's advice, and the reason for it: rules about capitals and symbols
    // do not buy entropy, they buy Passw0rd! — a password that satisfies every
    // rule and is on every list.
    expect(passwordSchema.parse('ทุกอย่างที่ยาวพอก็ผ่าน')).toBeTruthy();
    expect(passwordSchema.parse('aaaaaaaaaaaa')).toBe('aaaaaaaaaaaa');
  });

  it(`refuses anything shorter than ${PASSWORD_MIN_LENGTH}`, () => {
    expect(() => passwordSchema.parse('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow();
  });

  it('refuses a password longer than bcrypt actually reads', () => {
    // bcrypt hashes the first 72 BYTES and silently ignores the rest. Accepting
    // 200 characters would tell the owner they have a long password when the
    // last 128 characters of it are decoration.
    expect(() => passwordSchema.parse('a'.repeat(73))).toThrow();
  });

  it('counts bytes, not characters, because Thai is three bytes each', () => {
    // 24 Thai characters is 72 bytes — the real ceiling. 25 is over it, even
    // though a length check on the string would say 25 is fine.
    expect(passwordSchema.parse('ก'.repeat(24))).toBeTruthy();
    expect(() => passwordSchema.parse('ก'.repeat(25))).toThrow();
  });

  it('does not trim the password', () => {
    // A trailing space is part of the secret. Trimming it here would mean a
    // password that works on one client and not another.
    expect(passwordSchema.parse('             ')).toBe('             ');
  });
});

describe('the office login request', () => {
  it('lowercases and trims the email so the unique index means what it looks like', () => {
    const parsed = officeLoginRequestSchema.parse({
      email: '  Owner@Example.COM ',
      password: 'a-long-enough-password',
    });
    expect(parsed.email).toBe('owner@example.com');
  });

  it('refuses something that is not an email', () => {
    expect(() =>
      officeLoginRequestSchema.parse({ email: 'owner', password: 'a-long-enough-password' }),
    ).toThrow();
  });

  it('refuses a short password before it reaches bcrypt', () => {
    expect(() => officeLoginRequestSchema.parse({ email: 'a@b.co', password: 'short' })).toThrow();
  });
});
