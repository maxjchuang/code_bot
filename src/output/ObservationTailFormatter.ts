import type { CodexObservationSnapshot } from '../observations/CodexObservationStore.js';
import { formatDisplayTime } from './DisplayTimeFormatter.js';

export function formatObservationTail(snapshot: CodexObservationSnapshot, options: { timeZone?: string } = {}): string {
  if (snapshot.availability.kind === 'parse_error') {
    return `Structured Codex observation failed to parse. Reason: ${snapshot.availability.reason}. Use /rawtail 80 for raw terminal logs.`;
  }

  if (snapshot.availability.kind !== 'ready' && snapshot.availability.kind !== 'stale') {
    return 'No structured Codex observation yet. Use /rawtail 80 for raw terminal logs.';
  }

  const lines = [`Status: ${snapshot.status}`];
  if (snapshot.latestCommentary) {
    lines.push('', snapshot.latestCommentary);
  }
  if (snapshot.finalAnswer) {
    lines.push('', snapshot.finalAnswer);
  }
  if (snapshot.completedAt) {
    lines.push('', `Completed: ${formatDisplayTime(snapshot.completedAt, options.timeZone)}`);
  }

  const recentToolLines = snapshot.recentToolEvents.slice(-3).map((event) => `- ${event.summary}`);
  if (recentToolLines.length > 0) {
    lines.push('', 'Recent activity:', ...recentToolLines);
  }

  if (snapshot.availability.kind === 'stale') {
    lines.push('', 'Observation may be stale. Use /rawtail for the latest raw terminal output.');
  }

  return lines.join('\n');
}
