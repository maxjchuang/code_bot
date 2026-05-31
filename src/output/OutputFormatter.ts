export interface OutputLimits {
  directMaxChars: number;
  chunkSize: number;
}

export type FormattedOutput =
  | { kind: 'direct'; chunks: string[] }
  | { kind: 'summary'; chunks: string[]; summary: string };

export function formatOutput(text: string, limits: OutputLimits): FormattedOutput {
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
  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}
