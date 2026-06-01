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
  for (const candidateRawLines of scopeRawLineCandidatesForFinalAnswer(input.rawLines)) {
    const answerLines = extractAnswerLines(candidateRawLines, input.prompt);
    if (answerLines.length === 0) {
      continue;
    }
    return { kind: 'answer', text: truncateWithTailHint(answerLines.join('\n').trim(), input.maxChars) };
  }
  return { kind: 'empty', reason: 'No final answer detected.' };
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
    line.startsWith('›') ||
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

function scopeRawLineCandidatesForFinalAnswer(rawLines: string[]): string[][] {
  const dividerIndexes: number[] = [];
  let lastCommandIndex = -1;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? '';
    if (isDividerLine(line)) {
      dividerIndexes.push(index);
    }
    if (isCommandTranscriptLine(line)) {
      lastCommandIndex = index;
    }
  }

  const lastDividerIndex = dividerIndexes.at(-1) ?? -1;
  if (lastCommandIndex >= 0 && lastDividerIndex < lastCommandIndex && dividerIndexes.length === 0) {
    return [];
  }

  if (dividerIndexes.length === 0) {
    return [rawLines];
  }

  return [...dividerIndexes].reverse().map((index) => rawLines.slice(index + 1));
}

function extractAnswerLines(rawLines: string[], promptText?: string): string[] {
  const sanitized = sanitizeTerminalOutput(rawLines.map(protectMarkdownHorizontalRule));
  const prompt = normalizeComparable(promptText ?? '');
  const lines = sanitized.readableLines
    .flatMap((line) => line.split('\n'))
    .map(restoreMarkdownHorizontalRule)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isProcessLine(line))
    .filter((line) => normalizeComparable(line) !== prompt)
    .filter((line) => !line.startsWith(`› ${promptText ?? ''}`));

  return dropCommandTranscript(lines);
}

function isDividerLine(line: string): boolean {
  return /─{16,}/.test(stripTerminalControlSequences(line));
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
