/**
 * Print agent — the process that runs on the Raspberry Pi in the shop.
 *
 * Loop: ask the API for a job, print it, report what happened, repeat.
 *
 * Design notes that matter in a real shop:
 *  - it prints ONE job at a time. Two concurrent prints on one printer
 *    interleave into garbage.
 *  - a printer error is reported to the API, which decides whether to retry.
 *    Retry state lives in the database, not here, so unplugging the Pi does
 *    not lose the queue.
 *  - losing the network is not an error condition. It waits.
 */

import { PrintJobType, type PrintJob } from '@pos/shared';
import { loadConfig, type AgentConfig } from './config.js';
import { ApiClient } from './api-client.js';
import { createPrinter, type PrinterDriver } from './printer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new ApiClient(config);
  const printer = createPrinter(config);

  log(`station "${config.STATION}" as "${config.AGENT_ID}"`);
  log(`printer: ${printer.description}`);
  log(`api: ${config.API_URL}`);

  if (config.PRINTER_INTERFACE !== 'dry-run') {
    const reachable = await printer.isReachable();
    // Not fatal: the printer is often switched on after the Pi boots.
    log(
      reachable
        ? 'printer responded to the connection check'
        : 'WARNING: printer did not respond — will still try when a job arrives',
    );
  }

  let running = true;
  const stop = (signal: string): void => {
    log(`${signal} received — finishing the current job then exiting`);
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Avoids a tight spin against a dead API, without hiding a real outage.
  let quietCycles = 0;

  while (running) {
    const claim = await api.claimNext();

    if (!claim.ok) {
      if (quietCycles % 20 === 0) log(`cannot reach API: ${claim.error}`);
      quietCycles += 1;
      await sleep(config.POLL_INTERVAL_MS * 2);
      continue;
    }

    if (claim.data === null) {
      quietCycles += 1;
      await sleep(config.POLL_INTERVAL_MS);
      continue;
    }

    quietCycles = 0;
    await handleJob(api, printer, claim.data);
  }

  log('stopped');
}

async function handleJob(api: ApiClient, printer: PrinterDriver, job: PrintJob): Promise<void> {
  const startedAt = Date.now();
  log(`job ${job.id} (${job.type}) attempt ${job.attempts}/${job.maxAttempts}`);

  try {
    if (job.type === PrintJobType.DRAWER_KICK) {
      await printer.openDrawer();
    } else {
      await printer.print(job.document);
    }

    const durationMs = Date.now() - startedAt;
    log(`job ${job.id} printed in ${durationMs}ms`);
    const reported = await api.reportResult(job.id, { ok: true, durationMs });
    if (!reported.ok) {
      // The slip is already out of the machine — the API just does not know.
      // Reporting again would risk a duplicate, so this is logged and dropped;
      // the stale claim will be requeued only if it never reached PRINTED.
      log(`WARNING: printed but could not report job ${job.id}: ${reported.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown printer error';
    log(`job ${job.id} FAILED: ${message}`);
    const reported = await api.reportResult(job.id, {
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (!reported.ok) log(`WARNING: could not report failure for ${job.id}: ${reported.error}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(`[print-agent] ${new Date().toISOString()} ${message}`);
}

main().catch((error: unknown) => {
  console.error('[print-agent] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});

export type { AgentConfig };
