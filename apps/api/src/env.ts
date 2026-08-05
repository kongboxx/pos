/**
 * Environment configuration.
 *
 * Parsed once, at boot, through zod. A missing DATABASE_URL should kill the
 * process on startup with a readable message — not surface as a null pointer
 * during the lunch rush.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see apps/api/.env.example)'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  /// Shared secret the Raspberry Pi presents to claim print jobs.
  PRINT_AGENT_TOKEN: z.string().min(16, 'PRINT_AGENT_TOKEN must be at least 16 characters'),
  // zod's .url() only checks that `new URL()` parses, and it happily accepts
  // "localhost:5173" (protocol "localhost:"). CORS needs a real http origin,
  // so the protocol is checked explicitly.
  WEB_ORIGIN: z
    .string()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'WEB_ORIGIN must be a full http(s) origin, e.g. http://localhost:5173')
    .default('http://localhost:5173'),
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
