/**
 * Print agent configuration.
 *
 * Runs on a Raspberry Pi in the shop with no screen, so a bad setting must
 * fail at startup with a message a human can read over SSH — never halfway
 * through a lunch rush.
 */

import { z } from 'zod';

const configSchema = z.object({
  /** Where the API lives, e.g. http://192.168.1.20:3001/api */
  API_URL: z.string().url().default('http://localhost:3001/api'),
  /** Must match PRINT_AGENT_TOKEN on the API. */
  PRINT_AGENT_TOKEN: z.string().min(16),

  /** Which printer this process drives. One agent per station. */
  STATION: z.string().min(1).default('counter'),
  /** Stable across restarts so a stale claim can be recognised as ours. */
  AGENT_ID: z.string().min(1).default('pi-counter-1'),

  /**
   * Connection to the printer.
   *   tcp     — network printer, PRINTER_HOST:PRINTER_PORT (the usual setup)
   *   printer — an OS print queue by name (USB on Windows/CUPS)
   *   dry-run — render to stdout, touch no hardware
   */
  PRINTER_INTERFACE: z.enum(['tcp', 'printer', 'dry-run']).default('dry-run'),
  PRINTER_HOST: z.string().default('192.168.1.100'),
  PRINTER_PORT: z.coerce.number().int().min(1).max(65535).default(9100),
  /** OS queue name when PRINTER_INTERFACE=printer. */
  PRINTER_NAME: z.string().default(''),

  /**
   * ESC/POS command dialect. `epson` covers the overwhelming majority of
   * 80mm receipt printers sold in Thailand, including the generic ones.
   */
  PRINTER_TYPE: z.enum(['epson', 'star', 'tanca', 'daruma', 'brother', 'custom']).default('epson'),

  /**
   * Thai code page. TIS11_THAI and TIS18_THAI both encode as TIS-620 but
   * select a different font bank in the printer ROM (ESC t 21 vs ESC t 26).
   * Which one looks right is printer-specific — if tone marks land in the
   * wrong place, try the other before assuming the printer cannot do Thai.
   */
  PRINTER_CHARSET: z.enum(['TIS11_THAI', 'TIS18_THAI']).default('TIS11_THAI'),

  /** Printable columns: 48 for 80mm Font A, 32 for 58mm. */
  PRINTER_WIDTH: z.coerce.number().int().min(24).max(96).default(48),

  /** How often to ask the API for work when the queue was empty, in ms. */
  POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(1_500),
  /** Socket timeout talking to the printer. */
  PRINTER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid print agent configuration:\n${issues}`);
  }

  const config = parsed.data;
  if (config.PRINTER_INTERFACE === 'printer' && config.PRINTER_NAME === '') {
    throw new Error('PRINTER_NAME is required when PRINTER_INTERFACE=printer');
  }
  return config;
}

/** The interface string node-thermal-printer expects. */
export function printerInterface(config: AgentConfig): string {
  switch (config.PRINTER_INTERFACE) {
    case 'tcp':
      return `tcp://${config.PRINTER_HOST}:${config.PRINTER_PORT}`;
    case 'printer':
      return `printer:${config.PRINTER_NAME}`;
    case 'dry-run':
      return 'dry-run';
  }
}
