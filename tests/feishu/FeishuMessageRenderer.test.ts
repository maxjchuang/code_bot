import { describe, expect, it } from 'vitest';
import { renderFeishuMessage } from '../../src/feishu/FeishuMessageRenderer.js';

describe('renderFeishuMessage', () => {
  it('renders a normal-mode completion as a markdown card without debug metadata', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'completion',
        bodyMarkdown: '最终答案\n\n- 第一项\n- 第二项',
        fallbackText: '最终答案\n\n- 第一项\n- 第二项',
      },
      { verbosity: 'normal' },
    );

    expect(rendered.preferred.kind).toBe('card');
    expect(rendered.fallback.kind).toBe('text');
    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    expect(JSON.stringify(rendered.preferred.payload)).toContain('最终答案');
    expect(JSON.stringify(rendered.preferred.payload)).not.toContain('sessionId');
  });

  it('renders a debug-mode reply with an additional debug section', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: '已发送请求。',
        fallbackText: '已发送请求。',
        debug: { sessionId: 'sess_123', projectId: 'repo', source: 'observation' },
      },
      { verbosity: 'debug' },
    );

    expect(rendered.preferred.kind).toBe('card');
    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    expect(JSON.stringify(rendered.preferred.payload)).toContain('sess_123');
    expect(JSON.stringify(rendered.preferred.payload)).toContain('observation');
  });

  it('normalizes markdown into a safe subset for card rendering', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: '```ts\nconst x = 1\n```',
        fallbackText: 'const x = 1',
      },
      { verbosity: 'normal' },
    );

    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    expect(JSON.stringify(rendered.preferred.payload)).toContain('const x = 1');
  });
});
