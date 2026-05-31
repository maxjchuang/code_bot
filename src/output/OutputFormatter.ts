export interface OutputLimits {
  directMaxChars: number;
  chunkSize: number;
}

export type FormattedOutput =
  | { kind: 'direct'; chunks: string[] }
  | { kind: 'summary'; chunks: string[]; summary: string };

export function formatOutput(text: string, limits: OutputLimits): FormattedOutput {
  if (
    !Number.isInteger(limits.directMaxChars) ||
    limits.directMaxChars < 0 ||
    !Number.isFinite(limits.directMaxChars) ||
    !Number.isInteger(limits.chunkSize) ||
    limits.chunkSize <= 0 ||
    !Number.isFinite(limits.chunkSize)
  ) {
    throw new Error('Invalid output limits');
  }

  if (text.length <= limits.directMaxChars) {
    return { kind: 'direct', chunks: [text] };
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limits.chunkSize) {
    chunks.push(text.slice(index, index + limits.chunkSize));
  }

  return {
    kind: 'summary',
    chunks,
    summary: `Output is ${text.length} characters across ${chunks.length} chunks. Use /tail to inspect local logs.`,
  };
}

export function formatTail(lines: string[]): string {
  const content = lines.join('\n');
  const matches = content.match(/`+/g);
  const maxRun = matches === null ? 0 : Math.max(...matches.map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, maxRun + 1));
  return `${fence}text\n${content}\n${fence}`;
}
