import { describe, expect, it } from 'vitest';
import { buildTestReceipt, thaiWidth, type ReceiptDoc } from '@pos/shared';
import { applyDocument, DryRunPrinter } from './printer.js';

/**
 * Records every command instead of sending it to a printer, so the exact
 * sequence can be asserted. This is how "the drawer opens before the paper is
 * cut" gets verified without a drawer in the room.
 */
class RecordingPrinter {
  readonly calls: string[] = [];
  readonly lines: string[] = [];

  println(text: string): void {
    this.calls.push('println');
    this.lines.push(text);
  }
  alignLeft(): void {
    this.calls.push('alignLeft');
  }
  alignCenter(): void {
    this.calls.push('alignCenter');
  }
  bold(enabled: boolean): void {
    this.calls.push(`bold:${enabled}`);
  }
  setTextNormal(): void {
    this.calls.push('setTextNormal');
  }
  setTextDoubleHeight(): void {
    this.calls.push('setTextDoubleHeight');
  }
  setTextDoubleWidth(): void {
    this.calls.push('setTextDoubleWidth');
  }
  setTextQuadArea(): void {
    this.calls.push('setTextQuadArea');
  }
  printQR(data: string): void {
    this.calls.push(`printQR:${data}`);
  }
  openCashDrawer(): void {
    this.calls.push('openCashDrawer');
  }
  cut(): void {
    this.calls.push('cut');
  }
  newLine(): void {
    this.calls.push('newLine');
  }
}

const SHOP = { name: 'ร้านก๋วยเตี๋ยว', branchCode: 'HQ' };
const PRINTED_AT = new Date('2026-07-29T16:45:00Z');

describe('applyDocument — the command sequence sent to the printer', () => {
  it('opens the drawer BEFORE cutting the paper', () => {
    const printer = new RecordingPrinter();
    applyDocument(printer, buildTestReceipt({ shop: SHOP, printedAt: PRINTED_AT }));

    const drawerAt = printer.calls.indexOf('openCashDrawer');
    const cutAt = printer.calls.indexOf('cut');
    expect(drawerAt).toBeGreaterThan(-1);
    expect(cutAt).toBeGreaterThan(-1);
    expect(drawerAt).toBeLessThan(cutAt);
  });

  it('feeds paper before the cut so the last line is not sliced', () => {
    const printer = new RecordingPrinter();
    applyDocument(printer, { width: 48, blocks: [{ type: 'cut' }] });
    expect(printer.calls).toEqual(['alignLeft', 'newLine', 'newLine', 'cut']);
  });

  it('does not open the drawer when the document does not ask for it', () => {
    const printer = new RecordingPrinter();
    applyDocument(
      printer,
      buildTestReceipt({ shop: SHOP, printedAt: PRINTED_AT, openDrawer: false }),
    );
    expect(printer.calls).not.toContain('openCashDrawer');
    expect(printer.calls).toContain('cut');
  });

  it('always restores normal size and weight after an enlarged line', () => {
    const printer = new RecordingPrinter();
    applyDocument(printer, {
      width: 48,
      blocks: [
        { type: 'text', text: 'ใหญ่', size: 'large', bold: true },
        { type: 'text', text: 'ปกติ' },
      ],
    });
    // Anything left switched on would enlarge the rest of the slip.
    expect(printer.calls).toContain('setTextQuadArea');
    expect(printer.calls.indexOf('setTextNormal')).toBeGreaterThan(
      printer.calls.indexOf('setTextQuadArea'),
    );
    expect(printer.calls).toContain('bold:false');
  });

  it('centres a QR and returns alignment to the left afterwards', () => {
    const printer = new RecordingPrinter();
    applyDocument(printer, {
      width: 48,
      blocks: [{ type: 'qr', data: 'https://example.invalid', caption: 'สแกน' }],
    });
    expect(printer.calls).toEqual([
      'alignLeft',
      'alignCenter',
      'printQR:https://example.invalid',
      'println',
      'alignLeft',
    ]);
  });

  it('hands the printer lines that are already the exact paper width', () => {
    const printer = new RecordingPrinter();
    const doc: ReceiptDoc = {
      width: 48,
      blocks: [
        { type: 'item', qty: 2, name: 'ก๋วยเตี๋ยวหมูน้ำตก', amountSatang: 12000 },
        { type: 'row', left: 'รวมทั้งสิ้น', right: '235.00' },
        { type: 'divider' },
      ],
    };
    applyDocument(printer, doc);

    // If any line were not pre-padded, the printer would wrap it and the
    // money column would break.
    for (const line of printer.lines) {
      expect(thaiWidth(line)).toBe(48);
    }
  });
});

describe('DryRunPrinter', () => {
  it('writes the slip without touching hardware', async () => {
    const output: string[] = [];
    const printer = new DryRunPrinter((text) => output.push(text));

    await printer.print(buildTestReceipt({ shop: SHOP, printedAt: PRINTED_AT }));

    const text = output.join('\n');
    expect(text).toContain('ใบทดสอบเครื่องพิมพ์');
    expect(text).toContain('รวมทั้งสิ้น');
    expect(text).toContain('openDrawer');
    expect(text).toContain('cut');
  });

  it('reports itself as reachable so the loop can run with no printer', async () => {
    await expect(new DryRunPrinter(() => {}).isReachable()).resolves.toBe(true);
  });
});
