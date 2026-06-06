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
  footerStatus?: string;
  notes: string[];
}

export function renderCurrentScreenCard(
  input: RenderCurrentScreenCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const prepared = prepareRows(input.snapshot.rows, input.config);
  const notes = collectNotes(input.snapshot, prepared.notes);
  const bodyMarkdown = prepared.markdown.trim() ? prepared.markdown : '_Current screen is empty._';
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: bodyMarkdown,
    },
    {
      tag: 'markdown',
      content: renderFooterQuote(input, prepared.footerStatus),
      text_size: 'notation',
    },
  ];

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
  const footerStatus = preparedRows.find((row) => isCodexFooterStatusLine(row.text))?.text;
  const markdownRows = footerStatus
    ? preparedRows.filter((row) => row.text !== footerStatus)
    : preparedRows;

  return {
    rows: preparedRows,
    markdown: renderMarkdownRows(markdownRows),
    footerStatus,
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

function isVisualDividerRow(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  if (compact.length < 3) {
    return false;
  }

  const dividerChars = compact.match(/[─━═╭╮╰╯┌┐└┘├┤┬┴┼╞╡╪╔╗╚╝╠╣╦╩╬]/g)?.length ?? 0;
  return dividerChars / compact.length >= 0.8;
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

function renderMarkdownRows(rows: PreparedRow[]): string {
  const rendered: string[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const tableBlock = collectTableBlock(rows, index);
    if (tableBlock) {
      rendered.push(...renderMarkdownTable(tableBlock.rows));
      index = tableBlock.endIndex;
      continue;
    }

    rendered.push(renderMarkdownLine(rows[index].text));
  }

  return rendered.join('\n');
}

function collectTableBlock(rows: PreparedRow[], startIndex: number): { rows: string[][]; endIndex: number } | undefined {
  if (!isBoxTableLine(rows[startIndex].text)) {
    return undefined;
  }

  const tableRows: string[][] = [];
  let endIndex = startIndex;

  for (let index = startIndex; index < rows.length && isBoxTableLine(rows[index].text); index += 1) {
    endIndex = index;
    const cells = parseBoxTableCells(rows[index].text);
    if (cells.length > 0) {
      tableRows.push(cells);
    }
  }

  return tableRows.length >= 2 ? { rows: tableRows, endIndex } : undefined;
}

function renderMarkdownTable(rows: string[][]): string[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => normalizeTableRow(row, columnCount));
  const [header, ...bodyRows] = normalizedRows;

  return [
    renderMarkdownTableRow(header),
    renderMarkdownTableRow(Array.from({ length: columnCount }, () => '---')),
    ...bodyRows.map(renderMarkdownTableRow),
  ];
}

function normalizeTableRow(row: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? '');
}

function renderMarkdownTableRow(row: string[]): string {
  return `| ${row.map(escapeMarkdownTableCell).join(' | ')} |`;
}

function escapeMarkdownTableCell(text: string): string {
  return escapeFeishuMarkdownText(text.trim());
}

function renderMarkdownLine(text: string): string {
  if (isVisualDividerRow(text)) {
    return '---';
  }

  if (text.startsWith('• ')) {
    return `- ${escapeFeishuMarkdownText(text.slice(2))}`;
  }

  if (text.startsWith('› ')) {
    return `> ${escapeFeishuMarkdownText(text.slice(2))}`;
  }

  return escapeFeishuMarkdownText(text);
}

function isBoxTableLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes('│') || /^[┌┬┐├┼┤└┴┘─━═\s]+$/.test(trimmed);
}

function parseBoxTableCells(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('│') || !trimmed.endsWith('│')) {
    return [];
  }

  return trimmed
    .slice(1, -1)
    .split('│')
    .map((cell) => cell.trim());
}

function markdownCodeSpan(text: string): string {
  const escaped = escapeFeishuTagText(text);
  const delimiter = '`'.repeat(longestBacktickRun(escaped) + 1);
  return `${delimiter}${escaped}${delimiter}`;
}

function renderFooterQuote(input: RenderCurrentScreenCardInput, footerStatus: string | undefined): string {
  return [
    footerQuoteLine(`Session: ${markdownCodeSpan(input.sessionId)}`),
    footerQuoteLine(`Captured: ${markdownCodeSpan(input.snapshot.capturedAt)}`),
    ...(footerStatus ? [footerQuoteLine(escapeFeishuMarkdownText(footerStatus))] : []),
  ].join('\n');
}

function footerQuoteLine(content: string): string {
  return `> <font color='grey'>${content}</font>`;
}

function isCodexFooterStatusLine(text: string): boolean {
  return /^gpt-[^\n]+ · Context \d+% used · .+ used$/i.test(text.trim());
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
    ...renderFallbackRows(rows),
  ];

  if (notes.length > 0) {
    lines.push('', 'Notes:', ...notes.map((note) => `- ${note}`));
  }

  return lines.join('\n');
}

function renderFallbackRows(rows: PreparedRow[]): string[] {
  return rows.map((row) => (isVisualDividerRow(row.text) ? '---' : row.text));
}
