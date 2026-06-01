export interface SanitizedTerminalOutput {
  readableLines: string[];
  removedLineCount: number;
  hadControlSequences: boolean;
}

const BOXDRAWING_PATTERN = /^[\s╭╮╰╯│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]+$/u;
const WARNING_PATTERN = /(⚠|warning|error|failed|failure|not logged in|denied|invalid|missing|cannot|can't)/i;
const WORKING_REDRAW_PATTERN = /^[\s\d•·Workingorkin]+$/;

export function sanitizeTerminalOutput(lines: string[]): SanitizedTerminalOutput {
  const readableLines: string[] = [];
  let removedLineCount = 0;
  let hadControlSequences = false;
  let previousLine: string | undefined;
  let previousWasBlank = false;

  for (const line of lines) {
    const rendered = renderTerminalLine(line);
    hadControlSequences = hadControlSequences || rendered.hadControlSequences;
    for (const renderedLine of rendered.lines) {
      const normalized = normalizeReadableLine(renderedLine);

      if (shouldDropLine(normalized, rendered.hadControlSequences)) {
        removedLineCount += 1;
        continue;
      }

      if (normalized === '') {
        if (previousWasBlank) {
          removedLineCount += 1;
          continue;
        }
        previousWasBlank = true;
        previousLine = normalized;
        readableLines.push(normalized);
        continue;
      }

      previousWasBlank = false;
      if (normalized === previousLine) {
        removedLineCount += 1;
        continue;
      }

      previousLine = normalized;
      readableLines.push(normalized);
    }
  }

  while (readableLines[0] === '') {
    readableLines.shift();
    removedLineCount += 1;
  }
  while (readableLines[readableLines.length - 1] === '') {
    readableLines.pop();
    removedLineCount += 1;
  }

  return { readableLines, removedLineCount, hadControlSequences };
}

function renderTerminalLine(text: string): { lines: string[]; hadControlSequences: boolean } {
  const rows = [''];
  let hadControlSequences = false;
  let row = 0;
  let column = 0;
  let index = 0;

  const ensureRow = (targetRow: number): void => {
    while (rows.length <= targetRow) {
      rows.push('');
    }
  };

  const writeText = (value: string): void => {
    ensureRow(row);
    const current = rows[row];
    rows[row] = `${current.slice(0, column)}${value}${current.slice(column + value.length)}`;
    column += value.length;
  };

  while (index < text.length) {
    const code = text.charCodeAt(index);

    if (code === 0x1b) {
      hadControlSequences = true;
      const sequence = readEscapeSequence(text, index + 1);
      applyEscapeSequence(sequence, {
        rows,
        get row() {
          return row;
        },
        set row(value: number) {
          row = Math.max(0, value);
          ensureRow(row);
        },
        get column() {
          return column;
        },
        set column(value: number) {
          column = Math.max(0, value);
        },
      });
      index = sequence.end;
      continue;
    }

    if (code === 0x0a) {
      row += 1;
      column = 0;
      ensureRow(row);
      index += 1;
      continue;
    }

    if (code === 0x0d) {
      hadControlSequences = true;
      column = 0;
      index += 1;
      continue;
    }

    if (isStrippedC0Control(code)) {
      hadControlSequences = true;
      index += 1;
      continue;
    }

    writeText(text[index] ?? '');
    index += 1;
  }

  if (!hadControlSequences) {
    return { lines: rows, hadControlSequences };
  }

  const nonEmptyRows = rows.filter((screenLine) => screenLine.length > 0);
  return { lines: nonEmptyRows.length > 0 ? nonEmptyRows : [''], hadControlSequences };
}

interface EscapeSequence {
  kind: 'csi' | 'string' | 'single';
  final: string;
  params: string;
  end: number;
}

interface TerminalCursor {
  rows: string[];
  row: number;
  column: number;
}

function readEscapeSequence(text: string, index: number): EscapeSequence {
  if (index >= text.length) {
    return { kind: 'single', final: '', params: '', end: text.length };
  }

  const code = text.charCodeAt(index);
  if (code === 0x5b) {
    const end = consumeUntilFinalByte(text, index + 1);
    return { kind: 'csi', final: text[end - 1] ?? '', params: text.slice(index + 1, Math.max(index + 1, end - 1)), end };
  }

  if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return { kind: 'string', final: text[index] ?? '', params: '', end: consumeStringControl(text, index + 1) };
  }

  if (code >= 0x20 && code <= 0x2f) {
    let cursor = index + 1;
    while (cursor < text.length) {
      const intermediate = text.charCodeAt(cursor);
      if (intermediate < 0x20 || intermediate > 0x2f) {
        break;
      }
      cursor += 1;
    }
    return { kind: 'single', final: text[cursor] ?? '', params: '', end: cursor < text.length ? cursor + 1 : cursor };
  }

  return { kind: 'single', final: text[index] ?? '', params: '', end: index + 1 };
}

function applyEscapeSequence(sequence: EscapeSequence, cursor: TerminalCursor): void {
  if (sequence.kind !== 'csi') {
    return;
  }

  const params = parseCsiParams(sequence.params);
  switch (sequence.final) {
    case 'A':
      cursor.row -= params[0] ?? 1;
      break;
    case 'B':
      cursor.row += params[0] ?? 1;
      break;
    case 'C':
      cursor.column += params[0] ?? 1;
      break;
    case 'D':
      cursor.column -= params[0] ?? 1;
      break;
    case 'G':
      cursor.column = Math.max(0, (params[0] ?? 1) - 1);
      break;
    case 'H':
    case 'f':
      cursor.row = Math.max(0, (params[0] ?? 1) - 1);
      cursor.column = Math.max(0, (params[1] ?? 1) - 1);
      break;
    case 'J':
      eraseDisplay(cursor, params[0] ?? 0);
      break;
    case 'K':
      eraseLine(cursor, params[0] ?? 0);
      break;
  }
}

function parseCsiParams(params: string): number[] {
  return params
    .replace(/[?=><]/g, '')
    .split(';')
    .map((param) => (param === '' ? undefined : Number.parseInt(param, 10)))
    .map((param) => (Number.isFinite(param) ? param : undefined))
    .filter((param): param is number => param !== undefined);
}

function eraseDisplay(cursor: TerminalCursor, mode: number): void {
  if (mode === 2 || mode === 3) {
    cursor.rows.splice(0, cursor.rows.length, '');
    cursor.row = 0;
    cursor.column = 0;
    return;
  }
  if (mode === 0) {
    eraseLine(cursor, 0);
    cursor.rows.splice(cursor.row + 1);
  }
}

function eraseLine(cursor: TerminalCursor, mode: number): void {
  const line = cursor.rows[cursor.row] ?? '';
  if (mode === 2) {
    cursor.rows[cursor.row] = '';
    return;
  }
  if (mode === 1) {
    cursor.rows[cursor.row] = line.slice(cursor.column);
    cursor.column = 0;
    return;
  }
  cursor.rows[cursor.row] = line.slice(0, cursor.column);
}

function consumeUntilFinalByte(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) {
      return cursor;
    }
  }
  return text.length;
}

function consumeStringControl(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === 0x07) {
      return cursor + 1;
    }
    if (code === 0x1b && cursor + 1 < text.length && text.charCodeAt(cursor + 1) === 0x5c) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return text.length;
}

function isStrippedC0Control(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

function normalizeReadableLine(text: string): string {
  return text
    .replace(/[•·\s\dWorkingorkin]*·?\s*\d+\s+background terminal running\s+·\s+\/ps to view\s+·\s+\/stop to close/gi, '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.。！？:：])/g, '$1')
    .trim();
}

function shouldDropLine(line: string, hadControlSequences = false): boolean {
  if (line === '') {
    return false;
  }
  if (WARNING_PATTERN.test(line)) {
    return false;
  }
  if (line.startsWith('› ')) {
    return false;
  }
  if (BOXDRAWING_PATTERN.test(line)) {
    return true;
  }
  if (/^│.*(OpenAI Codex|model:|directory:|\/model to change).*│?$/i.test(line)) {
    return true;
  }
  if (/^[•·]?\s*Starting MCP servers\s*\([^)]+\):/i.test(line)) {
    return true;
  }
  if (/^\(?\d+s\s*•\s*esc to interrupt\)?$/i.test(line)) {
    return true;
  }
  if (/^gpt-[\w.-]+\s+.*\bContext\b.*used\b/i.test(line)) {
    return true;
  }
  if (hadControlSequences && /^\d+$/.test(line)) {
    return true;
  }
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S*$/.test(line)) {
    return true;
  }
  if (WORKING_REDRAW_PATTERN.test(line)) {
    return true;
  }
  if (/^[›•·*_\-|\s]+$/.test(line)) {
    return true;
  }
  if (line.length <= 2 && !/[A-Za-z0-9\u4e00-\u9fff]/u.test(line)) {
    return true;
  }
  return false;
}
