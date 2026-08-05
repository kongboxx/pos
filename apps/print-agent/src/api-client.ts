/**
 * Talks to the POS API.
 *
 * Shop wifi drops constantly, so a failed call is a normal event: every method
 * returns a result object rather than throwing, and the poll loop treats "no
 * network" the same as "no work" — it waits and tries again.
 */

import {
  claimResponseSchema,
  type ClaimResponse,
  type JobResult,
  type PrintJob,
} from '@pos/shared';
import type { AgentConfig } from './config.js';

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string };

export class ApiClient {
  constructor(private readonly config: AgentConfig) {}

  /** Asks for the next job. `null` means the queue is empty, which is normal. */
  async claimNext(): Promise<CallResult<PrintJob | null>> {
    const result = await this.post<ClaimResponse>('/print/agent/claim', {
      station: this.config.STATION,
      agentId: this.config.AGENT_ID,
    });
    if (!result.ok) return result;

    const parsed = claimResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      return { ok: false, error: `unexpected claim response: ${parsed.error.message}` };
    }
    return { ok: true, data: parsed.data.job };
  }

  async reportResult(jobId: string, result: JobResult): Promise<CallResult<void>> {
    const response = await this.post<unknown>(`/print/agent/jobs/${jobId}/result`, {
      agentId: this.config.AGENT_ID,
      ...result,
    });
    return response.ok ? { ok: true, data: undefined } : response;
  }

  private async post<T>(path: string, body: unknown): Promise<CallResult<T>> {
    try {
      const response = await fetch(`${this.config.API_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-print-agent-token': this.config.PRINT_AGENT_TOKEN,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, error: `HTTP ${response.status} ${text}`.trim() };
      }
      return { ok: true, data: (await response.json()) as T };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'network error' };
    }
  }
}
