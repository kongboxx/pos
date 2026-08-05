import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestReceipt } from '@pos/shared';
import { PrintTestPage } from './PrintTestPage.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const DOC = buildTestReceipt({
  shop: { name: 'ร้านทดสอบ', branchCode: 'HQ' },
  printedAt: new Date('2026-07-29T16:45:00Z'),
});

/** Routes fetch by URL so the page's preview / print / poll calls are separable. */
function stubApi(handlers: Record<string, () => unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string) => {
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (input.includes(fragment)) {
        return Promise.resolve({ ok: true, json: async () => handler() });
      }
    }
    return Promise.reject(new Error(`unstubbed ${input}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe('printer test page', () => {
  it('shows the receipt preview so the layout can be checked without hardware', async () => {
    stubApi({ '/print/preview': () => ({ document: DOC }) });

    render(<PrintTestPage />);

    await waitFor(() => {
      expect(screen.getByText(/ใบทดสอบเครื่องพิมพ์/)).toBeInTheDocument();
    });
    expect(screen.getByText(/รวมทั้งสิ้น/)).toBeInTheDocument();
  });

  it('queues a job and reports success once the agent prints it', async () => {
    const user = userEvent.setup();
    let statusCalls = 0;

    stubApi({
      '/print/preview': () => ({ document: DOC }),
      '/print/test': () => ({ jobId: '11111111-1111-4111-8111-111111111111', document: DOC }),
      '/print/jobs/': () => {
        statusCalls += 1;
        return {
          id: '11111111-1111-4111-8111-111111111111',
          // First poll still queued, then printed — mirrors the real timeline.
          status: statusCalls === 1 ? 'QUEUED' : 'PRINTED',
          attempts: statusCalls === 1 ? 0 : 1,
          maxAttempts: 3,
          lastError: null,
          claimedAt: null,
          printedAt: '2026-07-29T16:45:02.000Z',
        };
      },
    });

    render(<PrintTestPage />);
    await waitFor(() => expect(screen.getByText(/ใบทดสอบเครื่องพิมพ์/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'พิมพ์ใบทดสอบ' }));

    await waitFor(() => expect(screen.getByText('พิมพ์สำเร็จ')).toBeInTheDocument(), {
      timeout: 4000,
    });
  });

  it('tells the user the agent is not running when a job sits in the queue', async () => {
    const user = userEvent.setup();

    stubApi({
      '/print/preview': () => ({ document: DOC }),
      '/print/test': () => ({ jobId: '11111111-1111-4111-8111-111111111111', document: DOC }),
      '/print/jobs/': () => ({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 3,
        lastError: null,
        claimedAt: null,
        printedAt: null,
      }),
    });

    render(<PrintTestPage />);
    await waitFor(() => expect(screen.getByText(/ใบทดสอบเครื่องพิมพ์/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'พิมพ์ใบทดสอบ' }));

    await waitFor(() => {
      expect(screen.getByText(/ยังไม่มี print agent รับงาน/)).toBeInTheDocument();
    });
  });

  it('surfaces a printer failure rather than silently doing nothing', async () => {
    const user = userEvent.setup();

    stubApi({
      '/print/preview': () => ({ document: DOC }),
      '/print/test': () => ({ jobId: '11111111-1111-4111-8111-111111111111', document: DOC }),
      '/print/jobs/': () => ({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'FAILED',
        attempts: 3,
        maxAttempts: 3,
        lastError: 'connect ECONNREFUSED 192.168.1.100:9100',
        claimedAt: null,
        printedAt: null,
      }),
    });

    render(<PrintTestPage />);
    await waitFor(() => expect(screen.getByText(/ใบทดสอบเครื่องพิมพ์/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'พิมพ์ใบทดสอบ' }));

    await waitFor(() => {
      expect(screen.getByText(/พิมพ์ไม่สำเร็จ/)).toBeInTheDocument();
    });
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
  });
});
