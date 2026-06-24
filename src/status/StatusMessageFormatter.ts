import type { CachedCodexStatus, SessionStatus } from '../domain/types.js';
import { formatDisplayTime } from '../output/DisplayTimeFormatter.js';

export type StatusMessageInput = {
  session: {
    projectId?: string;
    sessionId?: string;
    status?: SessionStatus | 'none';
    phase?: string;
    summary?: string;
    pendingApprovals: string[];
  };
  codex:
    | { kind: 'available'; status: CachedCodexStatus }
    | { kind: 'unavailable' };
  runtime?: {
    installedCliVersion?: string;
  };
};

export type StatusMessage = {
  bodyMarkdown: string;
  fallbackText: string;
};

export function formatStatusMessage(input: StatusMessageInput, options: { timeZone?: string } = {}): StatusMessage {
  return {
    bodyMarkdown: [formatSessionMarkdown(input.session), formatCodexMarkdown(input.codex, input.runtime, options.timeZone)].join('\n\n'),
    fallbackText: [formatSessionFallback(input.session), formatCodexFallback(input.codex, input.runtime, options.timeZone)].join('\n\n'),
  };
}

function formatSessionMarkdown(input: StatusMessageInput['session']): string {
  const lines = [
    '## Session',
    `- **Project**: \`${valueOrNone(input.projectId)}\``,
    `- **Session**: \`${valueOrNone(input.sessionId)}\``,
    `- **Status**: \`${valueOrNone(input.status)}\``,
  ];

  if (input.phase) {
    lines.push(`- **Phase**: \`${input.phase}\``);
  }
  if (input.summary) {
    lines.push(`- **Summary**: ${input.summary}`);
  }
  if (input.pendingApprovals.length > 0) {
    lines.push(`- **Pending approvals**: \`${input.pendingApprovals.join(', ')}\``);
  }

  return lines.join('\n');
}

function formatCodexMarkdown(input: StatusMessageInput['codex'], runtime: StatusMessageInput['runtime'], timeZone?: string): string {
  if (input.kind === 'unavailable') {
    return '## Codex\nUnavailable';
  }

  const { status } = input;
  const lines = ['## Codex', `- **Source**: \`${status.source}\``, `- **Fetched at**: \`${formatDisplayTime(status.fetchedAt, timeZone)}\``];

  if (status.summary.statusLine) {
    lines.push(`- **Status**: \`${status.summary.statusLine}\``);
  }
  if (status.summary.currentTask) {
    lines.push(`- **Task**: ${status.summary.currentTask}`);
  }
  if (status.summary.progressHint) {
    lines.push(`- **Progress**: ${status.summary.progressHint}`);
  }
  if (status.summary.cliVersion) {
    lines.push(`- **CLI version**: \`${status.summary.cliVersion}\``);
  }
  if (runtime?.installedCliVersion) {
    lines.push(`- **Installed CLI version**: \`${runtime.installedCliVersion}\``);
  }
  if (status.summary.reasoningEffort) {
    lines.push(`- **Reasoning**: \`${status.summary.reasoningEffort}\``);
  }
  if (status.summary.summaryMode) {
    lines.push(`- **Summaries**: \`${status.summary.summaryMode}\``);
  }
  if (status.summary.permissions) {
    lines.push(`- **Permissions**: \`${status.summary.permissions}\``);
  }
  if (status.summary.collaborationMode) {
    lines.push(`- **Collaboration mode**: \`${status.summary.collaborationMode}\``);
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
  if (status.summary.primaryLimit) {
    lines.push(`- **5h limit**: \`${status.summary.primaryLimit}\``);
  }
  if (status.summary.weeklyLimit) {
    lines.push(`- **Weekly limit**: \`${status.summary.weeklyLimit}\``);
  }
  if (status.summary.planType) {
    lines.push(`- **Plan type**: \`${status.summary.planType}\``);
  }
  if (status.summary.model) {
    lines.push(`- **Model**: \`${status.summary.model}\``);
  }
  if (status.summary.cwd) {
    lines.push(`- **Working directory**: \`${status.summary.cwd}\``);
  }

  return lines.join('\n');
}

function formatSessionFallback(input: StatusMessageInput['session']): string {
  const lines = [
    'Session',
    `Project: ${valueOrNone(input.projectId)}`,
    `Session: ${valueOrNone(input.sessionId)}`,
    `Status: ${valueOrNone(input.status)}`,
  ];

  if (input.phase) {
    lines.push(`Phase: ${input.phase}`);
  }
  if (input.summary) {
    lines.push(`Summary: ${input.summary}`);
  }
  if (input.pendingApprovals.length > 0) {
    lines.push(`Pending approvals: ${input.pendingApprovals.join(', ')}`);
  }

  return lines.join('\n');
}

function formatCodexFallback(input: StatusMessageInput['codex'], runtime: StatusMessageInput['runtime'], timeZone?: string): string {
  if (input.kind === 'unavailable') {
    return 'Codex\nUnavailable';
  }

  const { status } = input;
  const lines = ['Codex', `Source: ${status.source}`, `Fetched at: ${formatDisplayTime(status.fetchedAt, timeZone)}`];

  if (status.summary.statusLine) {
    lines.push(`Status line: ${status.summary.statusLine}`);
  }
  if (status.summary.currentTask) {
    lines.push(`Task: ${status.summary.currentTask}`);
  }
  if (status.summary.progressHint) {
    lines.push(`Progress hint: ${status.summary.progressHint}`);
  }
  if (status.summary.cliVersion) {
    lines.push(`CLI version: ${status.summary.cliVersion}`);
  }
  if (runtime?.installedCliVersion) {
    lines.push(`Installed CLI version: ${runtime.installedCliVersion}`);
  }
  if (status.summary.reasoningEffort) {
    lines.push(`Reasoning: ${status.summary.reasoningEffort}`);
  }
  if (status.summary.summaryMode) {
    lines.push(`Summaries: ${status.summary.summaryMode}`);
  }
  if (status.summary.permissions) {
    lines.push(`Permissions: ${status.summary.permissions}`);
  }
  if (status.summary.collaborationMode) {
    lines.push(`Collaboration mode: ${status.summary.collaborationMode}`);
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
  if (status.summary.primaryLimit) {
    lines.push(`5h limit: ${status.summary.primaryLimit}`);
  }
  if (status.summary.weeklyLimit) {
    lines.push(`Weekly limit: ${status.summary.weeklyLimit}`);
  }
  if (status.summary.planType) {
    lines.push(`Plan type: ${status.summary.planType}`);
  }
  if (status.summary.model) {
    lines.push(`Model: ${status.summary.model}`);
  }
  if (status.summary.cwd) {
    lines.push(`Working directory: ${status.summary.cwd}`);
  }
  return lines.join('\n');
}

function valueOrNone(value?: string): string {
  return value && value.length > 0 ? value : 'none';
}
