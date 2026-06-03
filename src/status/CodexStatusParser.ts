import type { CachedCodexStatusSummary } from '../domain/types.js';

const FIELD_PATTERNS: Array<[keyof CachedCodexStatusSummary, RegExp]> = [
  ['statusLine', /^status:\s*(.+)$/i],
  ['currentTask', /^(task|current task):\s*(.+)$/i],
  ['progressHint', /^(progress|progress hint):\s*(.+)$/i],
  ['contextWindow', /^context window:\s*(.+)$/i],
  ['tokenUsage', /^(tokens|token usage):\s*(.+)$/i],
  ['model', /^model:\s*(.+)$/i],
  ['cwd', /^(cwd|working directory):\s*(.+)$/i],
];

export function parseCodexStatusText(text: string): CachedCodexStatusSummary {
  const summary: CachedCodexStatusSummary = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    for (const [key, pattern] of FIELD_PATTERNS) {
      const match = line.match(pattern);
      if (!match) {
        continue;
      }

      summary[key] = match.at(-1)?.trim();
      break;
    }
  }

  return summary;
}
