import type { CachedCodexStatus, SessionStatus } from '../domain/types.js';

export type StatusMessageInput = {
  session: {
    projectId?: string;
    sessionId?: string;
    status?: SessionStatus | 'none';
    summary?: string;
    pendingApprovals: string[];
  };
  codex:
    | { kind: 'available'; status: CachedCodexStatus }
    | { kind: 'unavailable' };
};

export type StatusMessage = {
  bodyMarkdown: string;
  fallbackText: string;
};

export function formatStatusMessage(input: StatusMessageInput): StatusMessage {
  const markdownSections = [formatSessionMarkdown(input.session), formatCodexMarkdown(input.codex)];
  const rawMarkdown = formatRawMarkdown(input.codex);
  if (rawMarkdown) {
    markdownSections.push(rawMarkdown);
  }

  return {
    bodyMarkdown: markdownSections.join('\n\n'),
    fallbackText: [formatSessionFallback(input.session), formatCodexFallback(input.codex)].join('\n\n'),
  };
}

function formatSessionMarkdown(input: StatusMessageInput['session']): string {
  const lines = [
    '## Session',
    `- **Project**: \`${valueOrNone(input.projectId)}\``,
    `- **Session**: \`${valueOrNone(input.sessionId)}\``,
    `- **Status**: \`${valueOrNone(input.status)}\``,
  ];

  if (input.summary) {
    lines.push(`- **Summary**: ${input.summary}`);
  }
  if (input.pendingApprovals.length > 0) {
    lines.push(`- **Pending approvals**: \`${input.pendingApprovals.join(', ')}\``);
  }

  return lines.join('\n');
}

function formatCodexMarkdown(input: StatusMessageInput['codex']): string {
  if (input.kind === 'unavailable') {
    return '## Codex\nUnavailable';
  }

  const { status } = input;
  const lines = ['## Codex', `- **Source**: \`${status.source}\``, `- **Fetched at**: \`${status.fetchedAt}\``];

  if (status.summary.statusLine) {
    lines.push(`- **Status**: \`${status.summary.statusLine}\``);
  }
  if (status.summary.currentTask) {
    lines.push(`- **Task**: ${status.summary.currentTask}`);
  }
  if (status.summary.progressHint) {
    lines.push(`- **Progress**: ${status.summary.progressHint}`);
  }
  if (status.summary.contextWindow) {
    lines.push(`- **Context window**: \`${status.summary.contextWindow}\``);
  }
  if (status.summary.tokenUsage) {
    lines.push(`- **Token usage**: \`${status.summary.tokenUsage}\``);
  }
  if (status.summary.lastTokenUsage) {
    lines.push(`- **Last turn tokens**: \`${status.summary.lastTokenUsage}\``);
  }
  if (status.summary.rateLimits) {
    lines.push(`- **Rate limits**: \`${status.summary.rateLimits}\``);
  }
  if (status.summary.resetTimes) {
    lines.push(`- **Resets**: \`${status.summary.resetTimes}\``);
  }
  if (status.summary.model) {
    lines.push(`- **Model**: \`${status.summary.model}\``);
  }
  if (status.summary.cwd) {
    lines.push(`- **Working directory**: \`${status.summary.cwd}\``);
  }

  return lines.join('\n');
}

function formatRawMarkdown(input: StatusMessageInput['codex']): string | undefined {
  if (input.kind !== 'available' || !input.status.rawText) {
    return undefined;
  }

  return ['## Raw', '```text', input.status.rawText, '```'].join('\n');
}

function formatSessionFallback(input: StatusMessageInput['session']): string {
  const lines = [
    'Session',
    `Project: ${valueOrNone(input.projectId)}`,
    `Session: ${valueOrNone(input.sessionId)}`,
    `Status: ${valueOrNone(input.status)}`,
  ];

  if (input.summary) {
    lines.push(`Summary: ${input.summary}`);
  }
  if (input.pendingApprovals.length > 0) {
    lines.push(`Pending approvals: ${input.pendingApprovals.join(', ')}`);
  }

  return lines.join('\n');
}

function formatCodexFallback(input: StatusMessageInput['codex']): string {
  if (input.kind === 'unavailable') {
    return 'Codex\nUnavailable';
  }

  const { status } = input;
  const lines = ['Codex', `Source: ${status.source}`, `Fetched at: ${status.fetchedAt}`];

  if (status.summary.statusLine) {
    lines.push(`Status line: ${status.summary.statusLine}`);
  }
  if (status.summary.currentTask) {
    lines.push(`Task: ${status.summary.currentTask}`);
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
  if (status.summary.lastTokenUsage) {
    lines.push(`Last token usage: ${status.summary.lastTokenUsage}`);
  }
  if (status.summary.rateLimits) {
    lines.push(`Rate limits: ${status.summary.rateLimits}`);
  }
  if (status.summary.resetTimes) {
    lines.push(`Resets: ${status.summary.resetTimes}`);
  }
  if (status.summary.model) {
    lines.push(`Model: ${status.summary.model}`);
  }
  if (status.summary.cwd) {
    lines.push(`Working directory: ${status.summary.cwd}`);
  }
  if (status.rawText) {
    lines.push('', 'Raw:', status.rawText);
  }

  return lines.join('\n');
}

function valueOrNone(value?: string): string {
  return value && value.length > 0 ? value : 'none';
}
