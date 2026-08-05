import { describe, expect, it } from 'vitest';
import { loadConfig, printerInterface } from './config.js';

const VALID = {
  PRINT_AGENT_TOKEN: 'a-token-at-least-16-chars',
};

describe('loadConfig', () => {
  it('defaults to dry-run so a fresh checkout cannot spray a real printer', () => {
    const config = loadConfig(VALID);
    expect(config.PRINTER_INTERFACE).toBe('dry-run');
    expect(config.STATION).toBe('counter');
    expect(config.PRINTER_WIDTH).toBe(48);
    expect(config.PRINTER_CHARSET).toBe('TIS11_THAI');
  });

  it('rejects a token short enough to guess', () => {
    expect(() => loadConfig({ PRINT_AGENT_TOKEN: 'short' })).toThrow(/PRINT_AGENT_TOKEN/);
  });

  it('requires a queue name when printing through the OS', () => {
    expect(() => loadConfig({ ...VALID, PRINTER_INTERFACE: 'printer' })).toThrow(/PRINTER_NAME/);
    expect(() =>
      loadConfig({ ...VALID, PRINTER_INTERFACE: 'printer', PRINTER_NAME: 'POS-80' }),
    ).not.toThrow();
  });

  it('coerces numeric settings from environment strings', () => {
    const config = loadConfig({ ...VALID, PRINTER_PORT: '9100', PRINTER_WIDTH: '32' });
    expect(config.PRINTER_PORT).toBe(9100);
    expect(config.PRINTER_WIDTH).toBe(32);
  });

  it('rejects an unknown printer interface instead of guessing', () => {
    expect(() => loadConfig({ ...VALID, PRINTER_INTERFACE: 'bluetooth' })).toThrow();
  });
});

describe('printerInterface', () => {
  it('builds a tcp target for a network printer', () => {
    const config = loadConfig({
      ...VALID,
      PRINTER_INTERFACE: 'tcp',
      PRINTER_HOST: '192.168.1.50',
      PRINTER_PORT: '9100',
    });
    expect(printerInterface(config)).toBe('tcp://192.168.1.50:9100');
  });

  it('builds an OS queue target', () => {
    const config = loadConfig({
      ...VALID,
      PRINTER_INTERFACE: 'printer',
      PRINTER_NAME: 'XP-80C',
    });
    expect(printerInterface(config)).toBe('printer:XP-80C');
  });
});
