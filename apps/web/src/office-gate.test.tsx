/**
 * What a tablet with no signal sees when it lands on /office.
 *
 * This is the one part of the split that only ever runs when something has
 * gone wrong, which is exactly why it needs a test: nobody exercises it by
 * hand, and the alternative to it working is a white screen that reads as
 * "the app is broken" rather than "this screen needs a connection".
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeGate } from './office-gate.js';

function Boom(): React.ReactElement {
  // What `import()` does when the chunk was never cached and there is no wifi.
  throw new Error('Failed to fetch dynamically imported module');
}

const show = (children: React.ReactNode): void => {
  render(
    <MemoryRouter>
      <OfficeGate>{children}</OfficeGate>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  // React logs the caught error itself; the noise would drown the suite.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the back office loads', () => {
  it('gets out of the way', () => {
    show(<p>หน้าจัดการเมนู</p>);
    expect(screen.getByText('หน้าจัดการเมนู')).toBeInTheDocument();
  });
});

describe('the back office chunk cannot be fetched', () => {
  it('says the screen needs a connection instead of dying silently', () => {
    show(<Boom />);
    expect(screen.getByText('เปิดหน้าหลังร้านไม่ได้')).toBeInTheDocument();
    expect(screen.getByText(/ต้องต่อเน็ต/)).toBeInTheDocument();
  });

  it('explains that this is why the till still works', () => {
    // Not decoration. Without the reason, "หลังร้านเปิดไม่ได้" reads as a bug
    // and the next person removes the exclusion that makes the till fast.
    show(<Boom />);
    expect(screen.getByText(/เปิดบิลได้ตอนเน็ตหลุด/)).toBeInTheDocument();
  });

  it('offers a way back to work, not just an apology', () => {
    show(<Boom />);
    expect(screen.getByRole('button', { name: 'ลองใหม่' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'กลับไปหน้าโต๊ะ' })).toHaveAttribute(
      'href',
      '/pos/tables',
    );
  });
});
