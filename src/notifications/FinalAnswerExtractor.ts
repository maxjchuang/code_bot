import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';

const MARKDOWN_HORIZONTAL_RULE_PLACEHOLDER = '__CODE_BOT_MARKDOWN_HORIZONTAL_RULE__';
const COMMENTARY_PREFIXES = ['我先', '我会先', '接下来', '我先检查', '我先看'];

export type FinalAnswerExtraction =
  | { kind: 'answer'; text: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'failure'; reason: string; diagnostic?: string };

export type FinalAnswerSource = 'divider' | 'prompt_redraw' | 'standalone';

export interface ExtractFinalAnswerInput {
  rawLines: string[];
  prompt?: string;
  maxChars: number;
  requireCompletionMarker?: boolean;
}

export function extractFinalAnswer(input: ExtractFinalAnswerInput): FinalAnswerExtraction {
  return inspectFinalAnswer(input).extraction;
}

export function inspectFinalAnswer(input: ExtractFinalAnswerInput): {
  extraction: FinalAnswerExtraction;
  source?: FinalAnswerSource;
} {
  for (const candidate of scopeRawLineCandidatesForFinalAnswer(input.rawLines, input.prompt, input.requireCompletionMarker ?? false)) {
    const candidateRawLines = candidate.rawLines;
    const answerLines = extractAnswerLines(candidateRawLines, input.prompt);
    if (answerLines.length === 0) {
      continue;
    }
    return {
      extraction: { kind: 'answer', text: truncateWithTailHint(answerLines.join('\n').trim(), input.maxChars) },
      source: candidate.source,
    };
  }
  return { extraction: { kind: 'empty', reason: 'No final answer detected.' } };
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
  const tailCommand = input.sessionId ? `/tail ${input.sessionId}` : '/tail';
  return `Codex 任务结束，但未能提取明确最终回答。\n\n原因：${input.extraction.reason}${diagnostic}\n可使用 ${tailCommand} 查看最近输出。`;
}

function isProcessLine(line: string): boolean {
  return (
    line.includes('OpenAI Codex') ||
    line.startsWith('> You are in ') ||
    line.startsWith('Do you trust the contents of this directory?') ||
    line.includes('Working with untrusted contents') ||
    line.startsWith('1. Yes, continue') ||
    line.startsWith('2. No, quit') ||
    line.startsWith('Press enter to continue') ||
    line.includes('Update available!') ||
    line.startsWith('Release notes:') ||
    line.startsWith('Updating Codex via ') ||
    /^changed \d+ packages? in \d+s$/i.test(line) ||
    line.includes('Update ran successfully!') ||
    line.includes('Please restart Codex.') ||
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

function scopeRawLineCandidatesForFinalAnswer(
  rawLines: string[],
  prompt: string | undefined,
  requireCompletionMarker: boolean,
): Array<{ rawLines: string[]; source: FinalAnswerSource }> {
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
    if (hasPromptRedrawAfterAnswer(rawLines)) {
      return [{ rawLines, source: 'prompt_redraw' }];
    }
    if (requireCompletionMarker || !hasStandaloneAnswerWithoutTurnProgress(rawLines, prompt)) {
      return [];
    }
    return [{ rawLines, source: 'standalone' }];
  }

  return [...dividerIndexes].reverse().map((index) => ({ rawLines: rawLines.slice(index + 1), source: 'divider' as const }));
}

function hasPromptRedrawAfterAnswer(rawLines: string[]): boolean {
  const sanitized = sanitizeTerminalOutput(rawLines);
  let sawAnswerLikeLine = false;
  for (const line of sanitized.readableLines.flatMap((readableLine) => readableLine.split('\n'))) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith('›')) {
      if (sawAnswerLikeLine) {
        return true;
      }
      continue;
    }
    if (!isProcessLine(trimmed)) {
      sawAnswerLikeLine = true;
    }
  }
  return false;
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
    .filter((line) => !line.startsWith(`› ${promptText ?? ''}`))
    .filter((line) => !isLikelyCommentaryLine(line));

  return dropCommandTranscript(lines);
}

function hasStandaloneAnswerWithoutTurnProgress(rawLines: string[], promptText?: string): boolean {
  const prompt = normalizeComparable(promptText ?? '');
  const sanitized = sanitizeTerminalOutput(rawLines);
  let sawAnswerLikeLine = false;
  for (const line of sanitized.readableLines.flatMap((readableLine) => readableLine.split('\n'))) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const comparable = normalizeComparable(trimmed);
    if (comparable === prompt || trimmed.startsWith(`› ${promptText ?? ''}`)) {
      continue;
    }
    if (trimmed.startsWith('›')) {
      return false;
    }
    if (isDividerLine(trimmed) || isCommandTranscriptLine(trimmed) || isLikelyCommentaryLine(trimmed)) {
      return false;
    }
    if (
      trimmed.includes('esc to interrupt') ||
      /^•\s*Working/.test(trimmed) ||
      /^W*o*r*k*i*n*g*\d*$/.test(trimmed.replace(/[•\s]/g, ''))
    ) {
      return false;
    }
    if (isProcessLine(trimmed)) {
      continue;
    }
    sawAnswerLikeLine = true;
  }
  return sawAnswerLikeLine;
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

function isLikelyCommentaryLine(line: string): boolean {
  return line.startsWith('• ') && COMMENTARY_PREFIXES.some((prefix) => line.slice(2).startsWith(prefix));
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
