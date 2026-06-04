import type { CachedCodexStatus } from '../domain/types.js';

export type CodexStatusSection =
  | { kind: 'available'; status: CachedCodexStatus }
  | { kind: 'unavailable' };

export function formatCodexStatusSection(section: CodexStatusSection): string {
  if (section.kind === 'unavailable') {
    return 'Codex status: unavailable';
  }

  const { status } = section;
  const lines = ['Codex status', `Source: ${status.source}`, `Fetched at: ${status.fetchedAt}`];

  if (status.summary.statusLine) {
    lines.push(`Status line: ${status.summary.statusLine}`);
  }
  if (status.summary.currentTask) {
    lines.push(`Current task: ${status.summary.currentTask}`);
  }
  if (status.summary.progressHint) {
    lines.push(`Progress hint: ${status.summary.progressHint}`);
  }
  if (status.summary.contextWindow) {
    lines.push(`Context window: ${status.summary.contextWindow}`);
  }
  if (status.summary.tokenUsage) {
    lines.push(`Token usage: ${status.summary.tokenUsage}`);
  }
  if (status.summary.model) {
    lines.push(`Model: ${status.summary.model}`);
  }
  if (status.summary.cwd) {
    lines.push(`Working directory: ${status.summary.cwd}`);
  }

  return lines.join('\n');
}
