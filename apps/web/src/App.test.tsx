import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusPage } from './StatusPage.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Step 0 status screen', () => {
  it('shows the offline banner when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/ออฟไลน์/)).toBeInTheDocument();
    });
  });

  it('shows the branch count when the API answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', latencyMs: 4, branchCount: 1 }),
      }),
    );

    render(<StatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/ต่อฐานข้อมูลได้/)).toBeInTheDocument();
    });
    expect(screen.getByText(/มี 1 สาขา/)).toBeInTheDocument();
  });

  it('renders shared money math with two decimals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    render(<StatusPage />);

    // 2 x (50.00 + 10.00) + 10.00 = 130.00
    expect(await screen.findByText('130.00 บาท')).toBeInTheDocument();
  });
});
