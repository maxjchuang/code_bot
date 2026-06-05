import { createRequire } from 'node:module';
import type { IBufferCell, Terminal as XtermTerminal } from '@xterm/headless';
import type { TerminalSnapshotConfig } from '../domain/types.js';

export type TerminalStyleColor = 'red' | 'green' | 'yellow' | 'gray';

export interface TerminalSnapshotSpan {
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: TerminalStyleColor;
}

export interface TerminalSnapshotRow {
  text: string;
  spans: TerminalSnapshotSpan[];
}

export interface TerminalSnapshot {
  cols: number;
  rows: TerminalSnapshotRow[];
  capturedAt: string;
  source: 'live' | 'replay' | 'fallback' | 'final';
  truncated: boolean;
  notes: string[];
}

interface HeadlessModule {
  Terminal: new (options?: {
    allowProposedApi?: boolean;
    cols?: number;
    logLevel?: 'off';
    rows?: number;
    scrollback?: number;
    convertEol?: boolean;
  }) => XtermTerminal;
}

interface BoundedReplayInput {
  text: string;
  truncated: boolean;
}

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as HeadlessModule;

export class TerminalScreenBuffer {
  private terminal: XtermTerminal;

  constructor(private readonly config: TerminalSnapshotConfig) {
    this.terminal = this.createTerminal();
  }

  write(chunk: string): void {
    writeSyncToTerminal(this.terminal, chunk);
  }

  snapshot(source: TerminalSnapshot['source'] = 'live', notes: string[] = []): TerminalSnapshot {
    return this.createSnapshot(source, false, notes);
  }

  resetAndReplay(input: string | string[]): TerminalSnapshot {
    const bounded = boundReplayInput(input, this.config.replayMaxBytes);
    this.terminal = this.createTerminal();
    this.write(bounded.text);

    return this.createSnapshot(
      'replay',
      bounded.truncated,
      bounded.truncated ? ['Replay input was bounded to newest bytes.'] : [],
    );
  }

  private createTerminal(): XtermTerminal {
    return new Terminal({
      allowProposedApi: true,
      cols: this.config.cols,
      convertEol: true,
      logLevel: 'off',
      rows: this.config.rows,
      scrollback: this.config.scrollback,
    });
  }

  private createSnapshot(source: TerminalSnapshot['source'], truncated: boolean, notes: string[]): TerminalSnapshot {
    const activeBuffer = this.terminal.buffer.active;
    const rowCount = Math.min(this.config.rows, this.config.cardMaxRows);
    const rows: TerminalSnapshotRow[] = [];

    for (let offset = 0; offset < rowCount; offset += 1) {
      const line = activeBuffer.getLine(activeBuffer.viewportY + offset);
      rows.push(line ? extractRow(line, this.config) : { text: '', spans: [] });
    }

    return {
      cols: this.config.cols,
      rows,
      capturedAt: new Date().toISOString(),
      source,
      truncated,
      notes,
    };
  }
}

export function replayTerminalSnapshot(input: string | string[], config: TerminalSnapshotConfig): TerminalSnapshot {
  return new TerminalScreenBuffer(config).resetAndReplay(input);
}

function writeSyncToTerminal(terminal: XtermTerminal, chunk: string): void {
  const maybeTerminal = terminal as unknown as { _core?: { writeSync?: unknown } };
  const writeSync = maybeTerminal._core?.writeSync;

  if (typeof writeSync !== 'function') {
    throw new Error('Synchronous xterm write API is unavailable');
  }

  writeSync.call(maybeTerminal._core, chunk);
}

function extractRow(
  line: NonNullable<ReturnType<XtermTerminal['buffer']['active']['getLine']>>,
  config: TerminalSnapshotConfig,
): TerminalSnapshotRow {
  const text = line.translateToString(true, 0, config.cols).slice(0, config.cardMaxLineChars);
  const spans: TerminalSnapshotSpan[] = [];
  let current: TerminalSnapshotSpan | undefined;
  let currentStyleKey = '';
  let renderedChars = 0;

  for (let column = 0; column < Math.min(line.length, config.cols) && renderedChars < text.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }

    const chars = cell.getChars();
    if (chars === '') {
      continue;
    }

    const remainingChars = text.length - renderedChars;
    const segmentText = chars.length > remainingChars ? chars.slice(0, remainingChars) : chars;
    const style = getSupportedStyle(cell);

    if (style === undefined) {
      current = undefined;
      currentStyleKey = '';
      renderedChars += segmentText.length;
      continue;
    }

    const styleKey = styleToKey(style);
    if (current && currentStyleKey === styleKey) {
      current.text += segmentText;
    } else if (spans.length < config.maxStyledSegmentsPerLine) {
      current = { text: segmentText, ...style };
      currentStyleKey = styleKey;
      spans.push(current);
    } else {
      current = undefined;
      currentStyleKey = '';
    }

    renderedChars += segmentText.length;
  }

  return { text, spans };
}

function getSupportedStyle(cell: IBufferCell): Omit<TerminalSnapshotSpan, 'text'> | undefined {
  const style: Omit<TerminalSnapshotSpan, 'text'> = {};
  const color = mapPaletteColor(cell.getFgColor());

  if (cell.isBold()) {
    style.bold = true;
  }
  if (cell.isDim()) {
    style.dim = true;
  }
  if (color) {
    style.color = color;
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

function mapPaletteColor(color: number): TerminalStyleColor | undefined {
  switch (color) {
    case 1:
    case 9:
      return 'red';
    case 2:
    case 10:
      return 'green';
    case 3:
    case 11:
      return 'yellow';
    case 7:
    case 8:
      return 'gray';
    default:
      return undefined;
  }
}

function styleToKey(style: Omit<TerminalSnapshotSpan, 'text'>): string {
  return `${style.bold ? '1' : '0'}:${style.dim ? '1' : '0'}:${style.color ?? ''}`;
}

function boundReplayInput(input: string | string[], replayMaxBytes: number): BoundedReplayInput {
  const text = Array.isArray(input) ? input.join('') : input;
  const bytes = Buffer.from(text, 'utf8');

  if (bytes.length <= replayMaxBytes) {
    return { text, truncated: false };
  }

  return {
    text: bytes.subarray(bytes.length - replayMaxBytes).toString('utf8'),
    truncated: true,
  };
}
