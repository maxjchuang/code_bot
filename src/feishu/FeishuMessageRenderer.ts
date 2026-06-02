export type BotMessage = {
  kind: 'reply' | 'completion' | 'error';
  bodyMarkdown: string;
  fallbackText: string;
  debug?: {
    sessionId?: string;
    projectId?: string;
    source?: string;
    reason?: string;
    chunkInfo?: string;
  };
};

export type RenderedFeishuMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; payload: Record<string, unknown> };

export function renderFeishuMessage(
  message: BotMessage,
  options: { verbosity: 'normal' | 'debug' },
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const body = normalizeMarkdown(message.bodyMarkdown);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: body,
    },
  ];

  if (options.verbosity === 'debug' && message.debug) {
    const debugLines = Object.entries(message.debug)
      .filter(([, value]) => value)
      .map(([key, value]) => `- **${key}**: \`${value}\``);

    if (debugLines.length > 0) {
      elements.push({
        tag: 'markdown',
        content: `---\n**Debug**\n${debugLines.join('\n')}`,
      });
    }
  }

  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        body: {
          elements,
        },
      },
    },
    fallback: {
      kind: 'text',
      text: message.fallbackText,
    },
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').trim();
}
