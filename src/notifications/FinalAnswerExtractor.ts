import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';

const MARKDOWN_HORIZONTAL_RULE_PLACEHOLDER = '__CODE_BOT_MARKDOWN_HORIZONTAL_RULE__';

export type FinalAnswerExtraction =
  | { kind: 'answer'; text: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'failure'; reason: string; diagnostic?: string };

export interface ExtractFinalAnswerInput {
  rawLines: string[];
  prompt?: string;
  maxChars: number;
}

export function extractFinalAnswer(input: ExtractFinalAnswerInput): FinalAnswerExtraction {
  const scopedRawLines = scopeRawLinesForFinalAnswer(input.rawLines);
  if (scopedRawLines.length === 0) {
    return { kind: 'empty', reason: 'No final answer detected.' };
  }
  const sanitized = sanitizeTerminalOutput(scopedRawLines.map(protectMarkdownHorizontalRule));
  const prompt = normalizeComparable(input.prompt ?? '');
  const lines = sanitized.readableLines
    .flatMap((line) => line.split('\n'))
    .map(restoreMarkdownHorizontalRule)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isProcessLine(line))
    .filter((line) => normalizeComparable(line) !== prompt)
    .filter((line) => !line.startsWith(`› ${input.prompt ?? ''}`));

  const answerLines = dropCommandTranscript(lines);
  if (answerLines.length === 0) {
    return { kind: 'empty', reason: 'No final answer detected.' };
  }

  return { kind: 'answer', text: truncateWithTailHint(answerLines.join('\n').trim(), input.maxChars) };
}

export function formatCompletionNotification(input: {
  projectId: string;
  sessionId?: string;
  extraction: FinalAnswerExtraction;
}): string {
  if (input.extraction.kind === 'answer') {
    return `Codex 已完成：${input.projectId}\n\n${input.extraction.text}`;
  }
  const diagnostic = input.extraction.kind === 'failure' && input.extraction.diagnostic ? `\n\n${input.extraction.diagnostic}` : '';
  return `Codex 任务结束，但未能提取明确最终回答。\n\n原因：${input.extraction.reason}${diagnostic}\n可使用 /tail 查看最近输出。`;
}

function isProcessLine(line: string): boolean {
  return (
    line.includes('OpenAI Codex') ||
    line.startsWith('Tip:') ||
    line.startsWith('Starting MCP servers') ||
    line.startsWith('Booting MCP server') ||
    line.startsWith('⚠ The ') ||
    line.startsWith('⚠ MCP ') ||
    isCodexStatusOrQuotaLine(line) ||
    line.includes('esc to interrupt') ||
    /^•\s*Working/.test(line) ||
    /^W*o*r*k*i*n*g*\d*$/.test(line.replace(/[•\s]/g, '')) ||
    /^─{8,}$/.test(line)
  );
}

function scopeRawLinesForFinalAnswer(rawLines: string[]): string[] {
  let lastDividerIndex = -1;
  let lastCommandIndex = -1;
  for (let index = rawLines.length - 1; index >= 0; index -= 1) {
    const line = rawLines[index] ?? '';
    if (lastDividerIndex < 0 && isDividerLine(line)) {
      lastDividerIndex = index;
    }
    if (lastCommandIndex < 0 && isCommandTranscriptLine(line)) {
      lastCommandIndex = index;
    }
    if (lastDividerIndex >= 0 && lastCommandIndex >= 0) {
      break;
    }
  }
  if (lastCommandIndex >= 0 && lastDividerIndex < lastCommandIndex) {
    return [];
  }
  return lastDividerIndex >= 0 ? rawLines.slice(lastDividerIndex + 1) : rawLines;
}

function isDividerLine(line: string): boolean {
  return /^─{16,}$/.test(stripTerminalControlSequences(line).trim());
}

function isCommandTranscriptLine(line: string): boolean {
  return stripTerminalControlSequences(line).trim().startsWith('• Ran ');
}

function isCodexStatusOrQuotaLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (/^gpt-[\w.-]+\s+.*·/.test(lower)) {
    return /\b(context|weekly|daily|left|used)\b/.test(lower);
  }
  if (/^status:\s/.test(lower)) {
    return (
      lower.includes('background terminal') ||
      lower.includes('running') ||
      lower.includes('/ps') ||
      lower.includes('/stop') ||
      lower.includes('to view') ||
      lower.includes('to close')
    );
  }
  if (/^quota:\s/.test(lower)) {
    return /\b(daily|weekly|monthly|left|used|remaining|limit|reset)\b/.test(lower);
  }
  return /^context:?\s*\d+%/.test(lower) || /\bcontext\s+\d+%\s+used\b/.test(lower);
}

function protectMarkdownHorizontalRule(line: string): string {
  return /^-{3,}$/.test(stripTerminalControlSequences(line).trim()) ? MARKDOWN_HORIZONTAL_RULE_PLACEHOLDER : line;
}

function restoreMarkdownHorizontalRule(line: string): string {
  return line === MARKDOWN_HORIZONTAL_RULE_PLACEHOLDER ? '---' : line;
}

function stripTerminalControlSequences(line: string): string {
  return line
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '');
}

function dropCommandTranscript(lines: string[]): string[] {
  const answerLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('• Ran ')) {
      if (lines[index + 1]?.startsWith('└ ')) {
        index += 1;
      }
      continue;
    }
    answerLines.push(line);
  }
  return answerLines;
}

function normalizeComparable(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function truncateWithTailHint(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = '\n\n输出已截断，可使用 /tail 查看完整内容。';
  const prefixLength = maxChars - suffix.length - 1;
  if (prefixLength <= 0) {
    return `…${suffix}`.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, prefixLength)}…${suffix}`;
}
