export interface SanitizedTerminalOutput {
  readableLines: string[];
  removedLineCount: number;
  hadControlSequences: boolean;
}

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_].*?(?:\u001b\\)|[ -/]*[0-~])/g;
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
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
  const withoutAnsi = text.replace(ANSI_PATTERN, '');
  const withoutControls = withoutAnsi.replace(C0_CONTROL_PATTERN, '');
  return {
    text: withoutControls,
    hadControlSequences: withoutControls !== text,
  };
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
