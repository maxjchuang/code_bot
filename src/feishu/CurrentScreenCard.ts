import type { SessionStatus, TerminalSnapshotConfig } from '../domain/types.js';
import type { TerminalSnapshot, TerminalSnapshotRow } from '../output/TerminalScreenBuffer.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface RenderCurrentScreenCardInput {
  snapshot: TerminalSnapshot;
  config: TerminalSnapshotConfig;
  sessionId: string;
  projectId: string;
  status: SessionStatus;
}

interface PreparedRow {
  text: string;
}

interface PreparedRows {
  rows: PreparedRow[];
  markdown: string;
  notes: string[];
}

export function renderCurrentScreenCard(
  input: RenderCurrentScreenCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const prepared = prepareRows(input.snapshot.rows, input.config);
  const notes = collectNotes(input.snapshot, prepared.notes);
  const metadata = [
    `- **Session**: ${markdownCodeSpan(input.sessionId)}`,
    `- **Project**: ${markdownCodeSpan(input.projectId)}`,
    `- **Status**: ${markdownCodeSpan(input.status)}`,
    `- **Source**: ${markdownCodeSpan(input.snapshot.source)}`,
    `- **Captured**: ${markdownCodeSpan(input.snapshot.capturedAt)}`,
  ];
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: metadata.join('\n'),
    },
    {
      tag: 'markdown',
      content: prepared.markdown,
    },
  ];

  if (notes.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**Notes**\n${notes.map((note) => `- ${escapeFeishuMarkdownText(note)}`).join('\n')}`,
    });
  }

  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        header: {
          title: {
            tag: 'plain_text',
            content: 'Codex Current',
          },
        },
        body: {
          elements,
        },
      },
    },
    fallback: {
      kind: 'text',
      text: renderFallback(input, prepared.rows, notes),
    },
  };
}

function prepareRows(rows: TerminalSnapshotRow[], config: TerminalSnapshotConfig): PreparedRows {
  const notes = new Set<string>();
  const limitedRows = rows.slice(0, Math.max(0, config.cardMaxRows));
  if (rows.length > limitedRows.length) {
    notes.add('Rows were truncated to fit the Feishu card.');
  }

  const preparedRows = limitedRows.map((row) => prepareRow(row, config, notes));

  return {
    rows: preparedRows,
    markdown: terminalMarkdownBlock(preparedRows.map((row) => row.text)),
    notes: [...notes],
  };
}

function prepareRow(row: TerminalSnapshotRow, config: TerminalSnapshotConfig, notes: Set<string>): PreparedRow {
  const truncation = truncateText(row.text, config.cardMaxLineChars);
  if (truncation.truncated) {
    notes.add('Rows were truncated to fit the Feishu card.');
  }

  if (row.spans.length > config.maxStyledSegmentsPerLine) {
    notes.add('Some rows were rendered as plain text because they had too many styled spans.');
    return {
      text: truncation.text,
    };
  }

  const canRenderStyled = canRenderStyledRow(row, truncation);
  if (row.spans.length > 0 && !canRenderStyled) {
    notes.add('Some rows were rendered as plain text because their styles are too complex.');
  }

  return {
    text: truncation.text,
  };
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { text: '', truncated: text.length > 0 };
  }
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: maxChars === 1 ? '…' : `${text.slice(0, maxChars - 1)}…`,
    truncated: true,
  };
}

function canRenderStyledRow(row: TerminalSnapshotRow, truncation: { text: string; truncated: boolean }): boolean {
  if (row.spans.length === 0) {
    return false;
  }
  if (truncation.truncated) {
    return false;
  }
  const styledText = row.spans.map((span) => span.text).join('');
  return styledText === row.text && truncation.text === row.text;
}

function terminalMarkdownBlock(lines: string[]): string {
  const escaped = escapeFeishuTagText(lines.join('\n'));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(escaped) + 1));
  return `${fence}\n${escaped}\n${fence}`;
}

function markdownCodeSpan(text: string): string {
  const escaped = escapeFeishuTagText(text);
  const delimiter = '`'.repeat(longestBacktickRun(escaped) + 1);
  return `${delimiter}${escaped}${delimiter}`;
}

function escapeFeishuTagText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeFeishuMarkdownText(text: string): string {
  return escapeFeishuTagText(text).replace(/\\/g, '\\\\').replace(/([*_`[\]()#|{}])/g, '\\$1');
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
}

function collectNotes(snapshot: TerminalSnapshot, rowNotes: string[]): string[] {
  const notes = new Set<string>();

  if (snapshot.truncated) {
    notes.add('Snapshot was truncated before card rendering.');
  }
  for (const note of snapshot.notes) {
    notes.add(note);
  }
  for (const note of rowNotes) {
    notes.add(note);
  }

  return [...notes];
}

function renderFallback(input: RenderCurrentScreenCardInput, rows: PreparedRow[], notes: string[]): string {
  const lines = [
    'Codex Current',
    `Session: ${input.sessionId}`,
    `Project: ${input.projectId}`,
    `Status: ${input.status}`,
    `Source: ${input.snapshot.source}`,
    `Captured: ${input.snapshot.capturedAt}`,
    '',
    ...rows.map((row) => row.text),
  ];

  if (notes.length > 0) {
    lines.push('', 'Notes:', ...notes.map((note) => `- ${note}`));
  }

  return lines.join('\n');
}
