/**
 * Environment configuration.
 *
 * Parsed once, at boot, through zod. A missing DATABASE_URL should kill the
 * process on startup with a readable message — not surface as a null pointer
 * during the lunch rush.
 */

import { z } from 'zod';

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see apps/api/.env.example)'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  /// Shared secret the Raspberry Pi presents to claim print jobs.
  PRINT_AGENT_TOKEN: z.string().min(16, 'PRINT_AGENT_TOKEN must be at least 16 characters'),
  /**
   * Every origin allowed to send credentialed requests, comma-separated.
   *
   * TWO now, not one. The till runs on :5173 and the back office on :5174, and
   * both talk to this API cross-origin in dev with no vite proxy in between. A
   * single value here is precisely why the office could not reach the API at
   * all after plan 1 split it out — the browser refused the preflight and the
   * app never got as far as a login.
   *
   * In production both sites sit behind the reverse proxy and are same-origin
   * with the API, so no browser sends an Origin that needs allowing and this
   * can be left at its default.
   *
   * zod's .url() is not enough: it only checks that `new URL()` parses, and it
   * happily accepts "localhost:5173" (protocol "localhost:"). The protocol is
   * checked explicitly, on every entry — a typo in the SECOND origin is the
   * dangerous one, because CORS keeps working for the till and fails only for
   * the office, which reads like an office bug for as long as it takes to find.
   */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    )
    .refine((list) => list.length > 0, 'WEB_ORIGIN must list at least one origin')
    .refine(
      (list) => list.every(isHttpOrigin),
      'WEB_ORIGIN must be full http(s) origins separated by commas, e.g. http://localhost:5173,http://localhost:5174',
    ),

  /**
   * The host names the till is served on, comma-separated.
   *
   * `/auth/staff` and `/auth/branches` answer only to these. Leave it EMPTY in
   * development: both apps reach the API as localhost:3001, so there is no
   * Host that could tell them apart, and an empty list means the check does
   * not run rather than that nothing matches. See host-guard.ts.
   */
  TILL_HOSTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
