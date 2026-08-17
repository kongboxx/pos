import { describe, expect, it } from 'vitest';
import { generatePin, resolveNewShop, SHOP_DEFAULTS } from './new-shop.js';

/** Nothing set: the shape a shop owner gets by running `pnpm db:seed` bare. */
const NOTHING: NodeJS.ProcessEnv = {};

const pin = (): string => '4321';

describe('with nothing configured', () => {
  it('still produces a shop that can be opened', () => {
    const shop = resolveNewShop(NOTHING, pin);

    expect(shop.name).toBe(SHOP_DEFAULTS.name);
    expect(shop.branchCode).toBe(SHOP_DEFAULTS.branchCode);
    expect(shop.owner.fullName).toBe(SHOP_DEFAULTS.ownerFullName);
    expect(shop.owner.pin).toBe('4321');
  });

  it('says the PIN was made up, so the seed knows it must be printed', () => {
    // A generated PIN nobody is shown is a shop with no way in.
    expect(resolveNewShop(NOTHING, pin).pinWasGenerated).toBe(true);
  });
});

describe('when the owner names their shop', () => {
  it('takes the name, code, person and PIN as typed', () => {
    const shop = resolveNewShop(
      {
        SHOP_NAME: 'ผัดไทยเจ๊หน่อย',
        SHOP_CODE: 'PT1',
        OWNER_NAME: 'หน่อย ใจดี',
        OWNER_NICKNAME: 'เจ๊หน่อย',
        OWNER_PIN: '8391',
      },
      pin,
    );

    expect(shop).toMatchObject({
      name: 'ผัดไทยเจ๊หน่อย',
      branchCode: 'PT1',
      owner: { fullName: 'หน่อย ใจดี', nickname: 'เจ๊หน่อย', pin: '8391' },
      pinWasGenerated: false,
    });
  });

  it('trims what was typed', () => {
    expect(resolveNewShop({ SHOP_NAME: '  ร้านลุงหมี  ' }, pin).name).toBe('ร้านลุงหมี');
  });

  it('treats a blank variable as not set rather than as an empty name', () => {
    // `SHOP_NAME=` in a .env file is a common way of "commenting out" a line.
    expect(resolveNewShop({ SHOP_NAME: '   ', SHOP_CODE: '' }, pin)).toMatchObject({
      name: SHOP_DEFAULTS.name,
      branchCode: SHOP_DEFAULTS.branchCode,
    });
  });

  it('falls back to the full name for the nickname', () => {
    // The nickname is what the kitchen ticket and the shift record show; an
    // empty one there is worse than a long one.
    expect(resolveNewShop({ OWNER_NAME: 'สมชาย' }, pin).owner.nickname).toBe('สมชาย');
  });
});

describe('what it refuses', () => {
  it('refuses a branch code with a space in it', () => {
    // The code is frozen into every document number once the first receipt
    // prints (rule #9), so it is cheaper to refuse now than to explain later.
    expect(() => resolveNewShop({ SHOP_CODE: 'BR 1' }, pin)).toThrow(/SHOP_CODE/);
  });

  it('refuses a branch code longer than the document number allows', () => {
    expect(() => resolveNewShop({ SHOP_CODE: 'BANGKOK01' }, pin)).toThrow(/SHOP_CODE/);
  });

  it('refuses a PIN that is not four digits', () => {
    expect(() => resolveNewShop({ OWNER_PIN: '123' }, pin)).toThrow(/OWNER_PIN/);
    expect(() => resolveNewShop({ OWNER_PIN: '12345' }, pin)).toThrow(/OWNER_PIN/);
    expect(() => resolveNewShop({ OWNER_PIN: 'พันเอ็ด' }, pin)).toThrow(/OWNER_PIN/);
  });

  it('never puts the PIN in the error message', () => {
    // The message goes to a terminal that scrolls, to CI logs, and into the
    // screenshot someone sends when asking for help.
    expect(() => resolveNewShop({ OWNER_PIN: '99999' }, pin)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('99999') }),
    );
  });

  it('refuses a shop name too long for the branch record', () => {
    expect(() => resolveNewShop({ SHOP_NAME: 'ก'.repeat(81) }, pin)).toThrow(/SHOP_NAME/);
  });

  it('lists everything wrong at once', () => {
    // One run, one fix. Being told about the code and then the PIN on the next
    // run is two rounds of the same conversation.
    const boom = (): unknown => resolveNewShop({ SHOP_CODE: 'ร้าน', OWNER_PIN: 'abcd' }, pin);
    expect(boom).toThrow(/SHOP_CODE/);
    expect(boom).toThrow(/OWNER_PIN/);
  });
});

describe('the owner email and password', () => {
  it('defaults the email to something obviously a placeholder', () => {
    const shop = resolveNewShop({}, pin);
    // Not a real-looking address: this shows up on the setup screen and it must
    // read as "change me", not as an address that might be someone's.
    expect(shop.owner.email).toBe('owner@localhost');
  });

  it('takes the email from the environment, lowercased', () => {
    const shop = resolveNewShop({ OWNER_EMAIL: '  Noi@Example.COM ' }, pin);
    expect(shop.owner.email).toBe('noi@example.com');
  });

  it('rejects something that is not an email', () => {
    expect(() => resolveNewShop({ OWNER_EMAIL: 'noi' }, pin)).toThrow(/OWNER_EMAIL/);
  });

  it('generates a password when none is given, and says it did', () => {
    const shop = resolveNewShop({}, pin);
    expect(shop.passwordWasGenerated).toBe(true);
    expect(shop.owner.password.length).toBeGreaterThanOrEqual(16);
  });

  it('takes the password from the environment without touching it', () => {
    // Not trimmed, not normalised. Whatever the owner typed IS the password.
    const shop = resolveNewShop({ OWNER_PASSWORD: 'correct horse battery ' }, pin);
    expect(shop.owner.password).toBe('correct horse battery ');
    expect(shop.passwordWasGenerated).toBe(false);
  });

  it('rejects a password too short to be one', () => {
    expect(() => resolveNewShop({ OWNER_PASSWORD: 'short' }, pin)).toThrow(/OWNER_PASSWORD/);
  });

  it('never puts the password in the error message', () => {
    // This error goes to a terminal that scrolls, into CI logs, into a
    // screenshot someone sends for help. Same rule the PIN already follows.
    const secret = 'hunter2-but-long-enough-to-pass';
    try {
      resolveNewShop({ OWNER_PASSWORD: secret, SHOP_CODE: 'ไม่ถูก' }, pin);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('generates a different password every time', () => {
    const a = resolveNewShop({}, pin).owner.password;
    const b = resolveNewShop({}, pin).owner.password;
    expect(a).not.toBe(b);
  });

  it('generates a password with no look-alike characters in it', () => {
    // This gets read off a terminal and typed into a browser, once, by someone
    // who cannot ask for it again. 0/O and 1/l/I are how that goes wrong.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(resolveNewShop({}, pin).owner.password).not.toMatch(/[0O1lI]/);
    }
  });
});

describe('generatePin', () => {
  it('is always four digits, leading zeros included', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(generatePin()).toMatch(/^\d{4}$/);
    }
  });

  it('is not the same PIN every time', () => {
    const seen = new Set(Array.from({ length: 50 }, generatePin));
    expect(seen.size).toBeGreaterThan(1);
  });
});
