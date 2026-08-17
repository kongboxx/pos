/**
 * Deletes sessions that expired more than SESSION_RETENTION_DAYS ago.
 *
 * Run from cron once a day — the schedule itself is deployment work and lands
 * in plan 3. Until then this is a command someone can run, which is enough:
 * the table grows by a handful of rows a day in a shop this size, so nothing
 * breaks if it is not run for a month.
 *
 * Deliberately NOT wired into the API's boot. A cleanup that runs on startup
 * is a cleanup that runs during a deploy, at the one moment nobody wants a
 * long-running DELETE competing with the first requests of the day.
 */

import { PrismaClient } from '@prisma/client';
import { SESSION_RETENTION_DAYS, SessionService } from '../src/modules/auth/session.service.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // The secret is only used for hashing new IPs, and this never issues a
  // session. Passing a placeholder is honest about that; reading JWT_SECRET
  // here would suggest this script needs it.
  const sessions = new SessionService(prisma, 'unused-by-purge');
  const removed = await sessions.purgeExpired();

  console.log(`ลบเซสชันที่หมดอายุเกิน ${SESSION_RETENTION_DAYS} วัน: ${removed} แถว`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
