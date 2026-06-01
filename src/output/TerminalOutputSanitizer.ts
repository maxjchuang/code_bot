export interface SanitizedTerminalOutput {
  readableLines: string[];
  removedLineCount: number;
  hadControlSequences: boolean;
}

const BOXDRAWING_PATTERN = /^[\s╭╮╰╯│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]+$/u;
const WARNING_PATTERN = /(⚠|warning|error|failed|failure|not logged in|denied|invalid|missing|cannot|can't)/i;

export function sanitizeTerminalOutput(lines: string[]): SanitizedTerminalOutput {
  const readableLines: string[] = [];
  let removedLineCount = 0;
  let hadControlSequences = false;
  let previousLine: string | undefined;
  let previousWasBlank = false;

  for (const line of lines) {
    const stripped = stripTerminalControl(line);
    hadControlSequences = hadControlSequences || stripped.hadControlSequences;
    const normalized = normalizeReadableLine(stripped.text);

    if (shouldDropLine(normalized)) {
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

function stripTerminalControl(text: string): { text: string; hadControlSequences: boolean } {
  const chunks: string[] = [];
  let hadControlSequences = false;
  let plainStart = 0;
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);

    if (code === 0x1b) {
      hadControlSequences = true;
      if (plainStart < index) {
        chunks.push(text.slice(plainStart, index));
      }
      index = consumeEscapeSequence(text, index + 1);
      plainStart = index;
      continue;
    }

    if (isStrippedC0Control(code)) {
      hadControlSequences = true;
      if (plainStart < index) {
        chunks.push(text.slice(plainStart, index));
      }
      index += 1;
      plainStart = index;
      continue;
    }

    index += 1;
  }

  if (!hadControlSequences) {
    return { text, hadControlSequences: false };
  }

  if (plainStart < text.length) {
    chunks.push(text.slice(plainStart));
  }

  return { text: chunks.join(''), hadControlSequences };
}

function consumeEscapeSequence(text: string, index: number): number {
  if (index >= text.length) {
    return text.length;
  }

  const code = text.charCodeAt(index);
  if (code === 0x1b) {
    return index;
  }

  if (code === 0x5b) {
    return consumeUntilFinalByte(text, index + 1);
  }

  if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return consumeStringControl(text, index + 1);
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
    return cursor < text.length ? cursor + 1 : cursor;
  }

  return index + 1;
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
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.。！？:：])/g, '$1')
    .trim();
}

function shouldDropLine(line: string): boolean {
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
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S*$/.test(line)) {
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
