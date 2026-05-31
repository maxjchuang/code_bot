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
  | { kind: 'command'; name: CommandName | string; args: string[]; raw: string };

const payloadCommands = new Set(['send']);

export function parseIncomingText(text: string): IncomingText {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'message', text };
  }

  const firstSpace = trimmed.indexOf(' ');
  const name = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  const args = payloadCommands.has(name) ? (rest ? [rest] : []) : rest.split(/\s+/).filter(Boolean);

  return { kind: 'command', name, args, raw: trimmed };
}
