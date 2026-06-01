import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';

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
  const sanitized = sanitizeTerminalOutput(input.rawLines);
  const prompt = normalizeComparable(input.prompt ?? '');
  const lines = sanitized.readableLines
    .flatMap((line) => line.split('\n'))
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
  const tailCommand = input.sessionId ? `/tail ${input.sessionId}` : '/tail';
  return `Codex 任务结束，但未能提取明确最终回答。\n\n原因：${input.extraction.reason}${diagnostic}\n可使用 ${tailCommand} 查看最近输出。`;
}

function isProcessLine(line: string): boolean {
  return (
    line.includes('OpenAI Codex') ||
    line.startsWith('Tip:') ||
    line.startsWith('Starting MCP servers') ||
    line.startsWith('Booting MCP server') ||
    line.startsWith('⚠ The ') ||
    line.startsWith('⚠ MCP ') ||
    line.startsWith('gpt-') ||
    line.includes('Context ') ||
    line.includes('weekly ') ||
    line.includes('esc to interrupt') ||
    /^•\s*Working/.test(line) ||
    /^W*o*r*k*i*n*g*\d*$/.test(line.replace(/[•\s]/g, '')) ||
    /^[-─]{8,}$/.test(line)
  );
}

function dropCommandTranscript(lines: string[]): string[] {
  let lastDividerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^[-─]{8,}$/.test(lines[index] ?? '')) {
      lastDividerIndex = index;
      break;
    }
  }
  const scoped = lastDividerIndex >= 0 ? lines.slice(lastDividerIndex + 1) : lines;
  return scoped.filter((line) => !line.startsWith('• Ran ') && !line.startsWith('└ '));
}

function normalizeComparable(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function truncateWithTailHint(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = '\n\n输出已截断，可使用 /tail 查看完整内容。';
  return `${text.slice(0, Math.max(1, maxChars - 2))}…${suffix}`;
}
