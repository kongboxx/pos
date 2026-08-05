/**
 * Process entry point: load env, build the app, listen, shut down cleanly.
 *
 * Clean shutdown matters more than usual here — the tablet retries a failed
 * sync, but a half-written transaction on SIGTERM would leave a bill in limbo.
 */

import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { prisma } from './db.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`API ready on http://localhost:${env.PORT}/api/health`);
}

main().catch((error: unknown) => {
  console.error('[api] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
