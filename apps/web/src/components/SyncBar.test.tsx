/**
 * The connection bar.
 *
 * The behaviour worth protecting is the silence: a bar that is always on screen
 * gets ignored, and then the night the shop actually loses its server, nobody
 * notices until the bills do not add up.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSync } from '../offline/sync-store.js';
import { SyncBar } from './SyncBar.js';

const BILL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  useSync.setState({
    online: true,
    pending: 0,
    rejected: [],
    syncing: false,
    lastSyncedAt: null,
    retry: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
  });
});

describe('when everything is fine', () => {
  it('draws nothing at all', () => {
    const { container } = render(<SyncBar />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('when the connection is down', () => {
  it('says orders still work, and how much is waiting', () => {
    // Staff who think the till is broken start writing on paper, and then the
    // two versions of the evening never reconcile.
    useSync.setState({ online: false, pending: 3 });
    render(<SyncBar />);

    expect(screen.getByRole('status')).toHaveTextContent('ออฟไลน์');
    expect(screen.getByRole('status')).toHaveTextContent('สั่งอาหารได้ตามปกติ');
    expect(screen.getByRole('status')).toHaveTextContent('รอส่ง 3 รายการ');
  });
});

describe('when the server refused a bill', () => {
  beforeEach(() => {
    useSync.setState({
      online: true,
      pending: 2,
      rejected: [{ orderId: BILL_ID, message: '"ก๋วยเตี๋ยวหมู" หมดแล้ว', count: 2 }],
    });
  });

  it('shouts, and shows the server’s own reason when opened', async () => {
    const user = userEvent.setup();
    render(<SyncBar />);

    expect(screen.getByRole('alert')).toHaveTextContent('1 บิลที่ส่งเข้าระบบไม่ได้');
    await user.click(screen.getByRole('button', { name: /ส่งเข้าระบบไม่ได้/ }));

    expect(screen.getByText('"ก๋วยเตี๋ยวหมู" หมดแล้ว')).toBeInTheDocument();
  });

  it('offers both answers, and says what discarding destroys', async () => {
    const user = userEvent.setup();
    render(<SyncBar />);
    await user.click(screen.getByRole('button', { name: /ส่งเข้าระบบไม่ได้/ }));

    await user.click(screen.getByRole('button', { name: 'ลองส่งอีกครั้ง' }));
    expect(useSync.getState().retry).toHaveBeenCalledWith(BILL_ID);

    await user.click(screen.getByRole('button', { name: 'ทิ้งการแก้ไขบนเครื่องนี้' }));
    expect(useSync.getState().discard).toHaveBeenCalledWith(BILL_ID);
  });

  it('takes priority over the offline message', () => {
    // A rejection needs a decision; being offline only needs patience.
    useSync.setState({ online: false });
    render(<SyncBar />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
