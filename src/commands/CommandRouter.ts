export type CommandName =
  | 'help'
  | 'projects'
  | 'use'
  | 'new'
  | 'send'
  | 'status'
  | 'tail'
  | 'stop'
  | 'sessions'
  | 'approve'
  | 'reject';

export type IncomingText =
  | { kind: 'message'; text: string }
  | { kind: 'command'; name: string; args: string[]; raw: string };

const payloadCommands = new Set(['send']);

export function parseIncomingText(text: string): IncomingText {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'message', text };
  }

  const firstWhitespace = trimmed.search(/\s/);
  const hasWhitespace = firstWhitespace !== -1;
  const name = (hasWhitespace ? trimmed.slice(1, firstWhitespace) : trimmed.slice(1)).toLowerCase();
  const rest = hasWhitespace ? trimmed.slice(firstWhitespace + 1).trim() : '';
  const args = payloadCommands.has(name) ? (rest ? [rest] : []) : rest.split(/\s+/).filter(Boolean);

  return { kind: 'command', name, args, raw: trimmed };
}
