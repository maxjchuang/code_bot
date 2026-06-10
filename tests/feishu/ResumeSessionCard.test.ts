import { describe, expect, it } from 'vitest';
import { renderResumeSessionCard } from '../../src/feishu/ResumeSessionCard.js';
import { parseCardActionValue } from '../../src/feishu/FeishuCardActions.js';
import type { SessionRecord } from '../../src/domain/types.js';

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'sess_1',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-10T07:00:00.000Z',
    updatedAt: '2026-06-10T07:10:00.000Z',
    logPath: '/tmp/sess_1.log',
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
    ...overrides,
  };
}

describe('ResumeSessionCard', () => {
  it('renders a resume selector card with project-filtered sessions', () => {
    const rendered = renderResumeSessionCard({
      chatId: 'oc_1',
      chatType: 'group',
      projectId: 'repo',
      sessions: [
        session({ id: 'sess_repo_old', status: 'exited', updatedAt: '2026-06-10T07:10:00.000Z' }),
        session({ id: 'sess_repo_new', status: 'interrupted', updatedAt: '2026-06-10T08:20:00.000Z' }),
      ],
      timeZone: 'Asia/Shanghai',
      fallbackText: 'fallback',
    });

    expect(rendered.preferred.kind).toBe('card');
    if (rendered.preferred.kind !== 'card') {
      throw new Error('expected card');
    }
    const payload = rendered.preferred.payload as any;
    expect(payload.header.title.content).toBe('Resume Session');
    expect(JSON.stringify(payload)).toContain('Project');
    expect(JSON.stringify(payload)).toContain('repo');
    const form = payload.body.elements.find((element: any) => element.tag === 'form');
    const select = form.elements.find((element: any) => element.name === 'sessionId');
    expect(select.initial_option).toBe('sess_repo_new');
    expect(select.options.map((option: any) => option.value)).toEqual(['sess_repo_new', 'sess_repo_old']);
    const button = form.elements.find((element: any) => element.name === 'confirm_resume_select');
    expect(button.behaviors[0].value).toEqual({
      kind: 'resume_select',
      chatId: 'oc_1',
      chatType: 'group',
    });
  });

  it('renders a text fallback listing the same session ids', () => {
    const rendered = renderResumeSessionCard({
      chatId: 'oc_1',
      chatType: 'private',
      projectId: 'repo',
      sessions: [session({ id: 'sess_repo_old' })],
      timeZone: 'Asia/Shanghai',
      fallbackText:
        'Resume sessions for project repo:\nsess_repo_old | exited | 2026-06-10 15:10\nRun /resume <session> to resume.',
    });

    expect(rendered.fallback).toEqual({
      kind: 'text',
      text: 'Resume sessions for project repo:\nsess_repo_old | exited | 2026-06-10 15:10\nRun /resume <session> to resume.',
    });
  });

  it('parses resume_select session id from form values', () => {
    expect(
      parseCardActionValue(
        { kind: 'resume_select', chatId: 'oc_1', chatType: 'group', sessionId: 'ignored' },
        { sessionId: 'sess_selected' },
      ),
    ).toEqual({
      chatId: 'oc_1',
      chatType: 'group',
      action: { kind: 'resume_select', sessionId: 'sess_selected' },
    });
  });
});
