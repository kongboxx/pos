/**
 * Turns a ReceiptDoc into ESC/POS output.
 *
 * The layout is NOT delegated to node-thermal-printer's leftRight()/table()
 * helpers: those measure with String.length, which is wrong for Thai (see
 * thai-text.ts). Every line is pre-laid-out by @pos/shared to an exact cell
 * count and handed over as a finished string, so what the unit tests assert is
 * byte-for-byte what the printer receives.
 *
 * Two drivers share one interface:
 *   EscPosPrinter — the real machine
 *   DryRunPrinter — writes the slip to stdout, for wiring up the whole chain
 *                   before the hardware arrives
 */

import { renderReceiptText, type ReceiptBlock, type ReceiptDoc } from '@pos/shared';
import type { AgentConfig } from './config.js';
import { printerInterface } from './config.js';

export interface PrinterDriver {
  /** Throws with a human-readable reason if the slip did not come out. */
  print(doc: ReceiptDoc): Promise<void>;
  /** Kick the drawer with nothing to print. */
  openDrawer(): Promise<void>;
  /** Best-effort reachability check. False is not fatal on its own. */
  isReachable(): Promise<boolean>;
  readonly description: string;
}

/* ------------------------------------------------------------------ */
/* Dry run                                                             */
/* ------------------------------------------------------------------ */

export class DryRunPrinter implements PrinterDriver {
  readonly description = 'dry-run (no hardware)';

  constructor(private readonly write: (text: string) => void = console.log) {}

  print(doc: ReceiptDoc): Promise<void> {
    const rule = '='.repeat(doc.width);
    const body = renderReceiptText(doc)
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n');
    const actions = doc.blocks
      .filter((block) => block.type === 'openDrawer' || block.type === 'cut')
      .map((block) => block.type);

    this.write(`\n${rule}\n${body}\n${rule}\n[dry-run] actions: ${actions.join(', ') || 'none'}\n`);
    return Promise.resolve();
  }

  openDrawer(): Promise<void> {
    this.write('[dry-run] cash drawer kick');
    return Promise.resolve();
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/* ------------------------------------------------------------------ */
/* ESC/POS                                                             */
/* ------------------------------------------------------------------ */

export class EscPosPrinter implements PrinterDriver {
  readonly description: string;

  constructor(private readonly config: AgentConfig) {
    this.description = `${config.PRINTER_TYPE} via ${printerInterface(config)} (${config.PRINTER_CHARSET})`;
  }

  async print(doc: ReceiptDoc): Promise<void> {
    const printer = await this.createPrinter();
    applyDocument(printer, doc);
    await printer.execute();
  }

  async openDrawer(): Promise<void> {
    const printer = await this.createPrinter();
    printer.openCashDrawer();
    await printer.execute();
  }

  async isReachable(): Promise<boolean> {
    try {
      const printer = await this.createPrinter();
      return await printer.isPrinterConnected();
    } catch {
      return false;
    }
  }

  private async createPrinter() {
    // Imported lazily so `--help`, config errors and the dry-run path never
    // pay for loading the native-ish printer stack.
    const { ThermalPrinter, PrinterTypes } = await import('node-thermal-printer');

    const printer = new ThermalPrinter({
      type: PrinterTypes[this.config.PRINTER_TYPE.toUpperCase() as keyof typeof PrinterTypes],
      interface: printerInterface(this.config),
      width: this.config.PRINTER_WIDTH,
      // Lines arrive pre-padded to the exact cell count; letting the library
      // re-wrap them would undo the Thai-aware layout.
      breakLine: 'NONE' as never,
      removeSpecialCharacters: false,
      options: { timeout: this.config.PRINTER_TIMEOUT_MS },
    });

    // The TypeScript CharacterSet enum shipped with node-thermal-printer 4.6
    // omits the Thai code pages, but the runtime config defines them
    // (CODE_PAGE_TIS11_THAI / CODE_PAGE_TIS18_THAI -> iconv 'TIS-620').
    // setCharacterSet takes a plain string, so this is safe.
    printer.setCharacterSet(this.config.PRINTER_CHARSET);

    return printer;
  }
}

/* ------------------------------------------------------------------ */

/** Minimal surface of ThermalPrinter that the renderer touches. */
interface PrinterCommands {
  println(text: string): void;
  alignLeft(): void;
  alignCenter(): void;
  bold(enabled: boolean): void;
  setTextNormal(): void;
  setTextDoubleHeight(): void;
  setTextDoubleWidth(): void;
  setTextQuadArea(): void;
  printQR(data: string, settings?: { cellSize?: number }): void;
  openCashDrawer(): void;
  cut(): void;
  newLine(): void;
}

/**
 * Walks the document and emits printer commands.
 *
 * Exported so a fake `PrinterCommands` can record the exact call sequence in a
 * unit test — that is how "the drawer opens before the cut" is verified
 * without a drawer.
 */
export function applyDocument(printer: PrinterCommands, doc: ReceiptDoc): void {
  // Text lines are already padded to `doc.width`, so everything prints
  // left-aligned; alignment was baked into the padding.
  printer.alignLeft();

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'openDrawer':
        printer.openCashDrawer();
        break;

      case 'cut':
        // Feed a little so the cut does not slice through the last line.
        printer.newLine();
        printer.newLine();
        printer.cut();
        break;

      case 'qr':
        printer.alignCenter();
        printer.printQR(block.data, { cellSize: 6 });
        if (block.caption) printer.println(block.caption);
        printer.alignLeft();
        break;

      default:
        emitTextBlock(printer, block, doc);
        break;
    }
  }
}

function emitTextBlock(printer: PrinterCommands, block: ReceiptBlock, doc: ReceiptDoc): void {
  const lines = renderReceiptText({ width: doc.width, blocks: [block] });
  if (lines.length === 0) return;

  const bold = 'bold' in block && block.bold === true;
  const size = 'size' in block ? block.size : undefined;

  // A double-width line only fits half the columns, so it is centred by the
  // printer rather than by padding — re-render it unpadded.
  const isEnlarged = size === 'wide' || size === 'large';

  if (bold) printer.bold(true);
  applySize(printer, size);

  if (isEnlarged && block.type === 'text') {
    printer.alignCenter();
    printer.println(block.text);
    printer.alignLeft();
  } else {
    for (const line of lines) printer.println(line);
  }

  if (size && size !== 'normal') printer.setTextNormal();
  if (bold) printer.bold(false);
}

function applySize(printer: PrinterCommands, size: string | undefined): void {
  switch (size) {
    case 'wide':
      printer.setTextDoubleWidth();
      break;
    case 'tall':
      printer.setTextDoubleHeight();
      break;
    case 'large':
      printer.setTextQuadArea();
      break;
    default:
      break;
  }
}

/** Picks the driver the configuration asks for. */
export function createPrinter(config: AgentConfig): PrinterDriver {
  return config.PRINTER_INTERFACE === 'dry-run' ? new DryRunPrinter() : new EscPosPrinter(config);
}
