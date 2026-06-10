# Resume Session Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-isolated Feishu resume selector card for `/resume` with no arguments and bot floating menu resume events.

**Architecture:** Reuse the existing card selector architecture: a focused `ResumeSessionCard` renderer, a structured `resume_select` card action, and `SessionManager` helpers that filter sessions by current chat and current project. Direct text `/resume <session> [project]` remains unchanged, while card actions re-check current chat/project state before resuming.

**Tech Stack:** TypeScript, Vitest, existing Feishu card payload structures, `FileStateStore`, `SessionManager`, `LarkLongConnectionGateway`.

---

## File Structure

- Create `src/feishu/ResumeSessionCard.ts`: render the interactive resume card and text fallback.
- Create `tests/feishu/ResumeSessionCard.test.ts`: verify card payload, fallback, and project-filtered option rendering.
- Modify `src/feishu/FeishuCardActions.ts`: add `ResumeSelectCardAction` and parse `sessionId`.
- Modify `tests/feishu/FeishuGateway.test.ts`: verify bot menu key `resume` maps to `/resume`.
- Modify `src/feishu/FeishuGateway.ts`: add `resume` to `BOT_MENU_COMMANDS`.
- Modify `src/session/SessionManager.ts`: render `/resume` card with no target and handle `resume_select`.
- Modify `tests/session/SessionManager.test.ts`: cover no-project, active-session, empty-list, card rendering, project isolation, and card action resume behavior.

## Task 1: Resume Card Renderer

**Files:**
- Create: `src/feishu/ResumeSessionCard.ts`
- Create: `tests/feishu/ResumeSessionCard.test.ts`

- [ ] **Step 1: Write failing card renderer tests**

Create `tests/feishu/ResumeSessionCard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderResumeSessionCard } from '../../src/feishu/ResumeSessionCard.js';
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
      fallbackText: 'Resume sessions for project repo:\nsess_repo_old | exited | 2026-06-10 15:10\nRun /resume <session> to resume.',
    });

    expect(rendered.fallback).toEqual({
      kind: 'text',
      text: 'Resume sessions for project repo:\nsess_repo_old | exited | 2026-06-10 15:10\nRun /resume <session> to resume.',
    });
  });
});
```

- [ ] **Step 2: Run renderer tests and verify RED**

Run:

```bash
npm test -- tests/feishu/ResumeSessionCard.test.ts
```

Expected: FAIL because `src/feishu/ResumeSessionCard.ts` does not exist.

- [ ] **Step 3: Implement the renderer**

Create `src/feishu/ResumeSessionCard.ts`:

```ts
import type { ChatType, SessionRecord } from '../domain/types.js';
import { formatDisplayTime } from '../output/DisplayTimeFormatter.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface RenderResumeSessionCardInput {
  chatId: string;
  chatType: ChatType;
  projectId: string;
  sessions: SessionRecord[];
  timeZone: string;
  fallbackText: string;
}

export function renderResumeSessionCard(
  input: RenderResumeSessionCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const sessions = [...input.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const defaultSessionId = sessions[0]?.id;
  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Resume Session',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [`Choose a Codex session to resume.`, `- **Project**: \`${input.projectId}\``].join('\n'),
        },
        {
          tag: 'form',
          name: 'resume_select_form',
          elements: [
            {
              tag: 'select_static',
              name: 'sessionId',
              placeholder: {
                tag: 'plain_text',
                content: 'Select session',
              },
              initial_option: defaultSessionId,
              options: sessions.map((session) => ({
                text: {
                  tag: 'plain_text',
                  content: formatSessionOption(session, input.timeZone),
                },
                value: session.id,
              })),
            },
            {
              tag: 'button',
              name: 'confirm_resume_select',
              text: {
                tag: 'plain_text',
                content: 'Resume session',
              },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [
                {
                  type: 'callback',
                  value: {
                    kind: 'resume_select',
                    chatId: input.chatId,
                    chatType: input.chatType,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  return {
    preferred: { kind: 'card', payload },
    fallback: { kind: 'text', text: input.fallbackText },
  };
}

function formatSessionOption(session: SessionRecord, timeZone: string): string {
  return `${session.id} | ${session.status} | ${formatDisplayTime(session.updatedAt, timeZone)}`;
}
```

- [ ] **Step 4: Run renderer tests and verify GREEN**

Run:

```bash
npm test -- tests/feishu/ResumeSessionCard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit renderer**

```bash
git add src/feishu/ResumeSessionCard.ts tests/feishu/ResumeSessionCard.test.ts
git commit -m "feat: render resume session card"
```

## Task 2: Card Action Parsing And Bot Menu Mapping

**Files:**
- Modify: `src/feishu/FeishuCardActions.ts`
- Modify: `src/feishu/FeishuGateway.ts`
- Modify: `tests/feishu/FeishuGateway.test.ts`
- Modify: `tests/feishu/ResumeSessionCard.test.ts`

- [ ] **Step 1: Add failing tests for resume action parsing and menu mapping**

Append to `tests/feishu/ResumeSessionCard.test.ts`:

```ts
import { parseCardActionValue } from '../../src/feishu/FeishuCardActions.js';

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
```

In `tests/feishu/FeishuGateway.test.ts`, extend the existing menu mapping table:

```ts
['resume', '/resume'],
```

- [ ] **Step 2: Run action and gateway tests and verify RED**

Run:

```bash
npm test -- tests/feishu/ResumeSessionCard.test.ts tests/feishu/FeishuGateway.test.ts
```

Expected: FAIL because `resume_select` is not parsed and menu key `resume` is not mapped.

- [ ] **Step 3: Implement action parsing and menu mapping**

In `src/feishu/FeishuCardActions.ts`, add:

```ts
export interface ResumeSelectCardAction {
  kind: 'resume_select';
  sessionId: string;
}

export type FeishuCardActionPayload = ModelSelectCardAction | ProjectSelectCardAction | ResumeSelectCardAction;
```

Add this branch to `parseCardActionValue` after `project_select`:

```ts
if (value.kind === 'resume_select') {
  const sessionId = readString(form?.sessionId) ?? readString(value.sessionId);
  if (!sessionId) {
    return undefined;
  }
  return {
    chatId: value.chatId,
    chatType,
    action: { kind: 'resume_select', sessionId },
  };
}
```

In `src/feishu/FeishuGateway.ts`, add to `BOT_MENU_COMMANDS`:

```ts
resume: '/resume',
```

- [ ] **Step 4: Run action and gateway tests and verify GREEN**

Run:

```bash
npm test -- tests/feishu/ResumeSessionCard.test.ts tests/feishu/FeishuGateway.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit parser and menu mapping**

```bash
git add src/feishu/FeishuCardActions.ts src/feishu/FeishuGateway.ts tests/feishu/ResumeSessionCard.test.ts tests/feishu/FeishuGateway.test.ts
git commit -m "feat: parse resume card actions"
```

## Task 3: SessionManager Resume Card Command

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Add failing `/resume` card tests**

Append these tests near existing resume tests in `tests/session/SessionManager.test.ts`:

```ts
it('returns a resume card for current-project resumable sessions when /resume has no target', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });
  await store.saveSession({
    id: 'sess_repo',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-10T07:00:00.000Z',
    updatedAt: '2026-06-10T07:10:00.000Z',
    logPath: store.sessionLogPath('sess_repo'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });
  await store.saveSession({
    id: 'sess_other_project',
    chatId: 'oc_1',
    projectId: 'repo2',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-10T07:00:00.000Z',
    updatedAt: '2026-06-10T07:20:00.000Z',
    logPath: store.sessionLogPath('sess_other_project'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116f',
  });
  await store.saveSession({
    id: 'sess_not_resumable',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-10T07:00:00.000Z',
    updatedAt: '2026-06-10T07:30:00.000Z',
    logPath: store.sessionLogPath('sess_not_resumable'),
  });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume' });

  expect(result.reply).toContain('Resume sessions for project repo');
  expect(result.reply).toContain('sess_repo');
  expect(result.reply).not.toContain('sess_other_project');
  expect(result.reply).not.toContain('sess_not_resumable');
  expect(result.renderedReply?.preferred.kind).toBe('card');
  if (result.renderedReply?.preferred.kind !== 'card') {
    throw new Error('expected card');
  }
  const payload = JSON.stringify(result.renderedReply.preferred.payload);
  expect(payload).toContain('sess_repo');
  expect(payload).not.toContain('sess_other_project');
  expect(payload).not.toContain('sess_not_resumable');
});

it('asks for a project when /resume has no target and no current project is selected', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume' });

  expect(result.reply).toBe('Choose a project with /projects or /use <project> before resuming a session.');
});

it('returns an empty state when /resume has no current-project resumable sessions', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume' });

  expect(result.reply).toBe('No resumable sessions for project repo. Run /new repo to start one.');
});
```

- [ ] **Step 2: Run session tests and verify RED**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resume has no"
```

Expected: FAIL because `/resume` without target returns usage.

- [ ] **Step 3: Implement `/resume` card rendering**

In `src/session/SessionManager.ts`, import:

```ts
import { renderResumeSessionCard } from '../feishu/ResumeSessionCard.js';
```

Change the start of `resumeSession`:

```ts
if (!target) {
  return this.resumeSessionCard(input);
}
```

Add helper methods:

```ts
private async resumeSessionCard(input: IncomingBotText): Promise<BotTextResult> {
  const listed = await this.listResumableSessionsForCurrentProject(input.chatId);
  if (!listed.ok) {
    return { reply: listed.reply };
  }

  const fallbackText = formatResumeSessionFallback(listed.chat.currentProjectId!, listed.sessions, this.config.ui.timeZone);
  return {
    reply: fallbackText,
    renderedReply: renderResumeSessionCard({
      chatId: input.chatId,
      chatType: input.chatType,
      projectId: listed.chat.currentProjectId!,
      sessions: listed.sessions,
      timeZone: this.config.ui.timeZone,
      fallbackText,
    }),
  };
}

private async listResumableSessionsForCurrentProject(chatId: string): Promise<
  | { ok: true; chat: ChatContext; sessions: SessionRecord[] }
  | { ok: false; reply: string }
> {
  const chat = await this.store.getChat(chatId);
  if (!chat?.currentProjectId) {
    return { ok: false, reply: 'Choose a project with /projects or /use <project> before resuming a session.' };
  }
  const currentSession = chat.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  if (currentSession && isActiveSession(currentSession)) {
    return { ok: false, reply: `Current session ${currentSession.id} is still running. Run /stop before resuming another session.` };
  }
  const sessions = (await this.store.listSessionsByChat(chatId, 50))
    .filter((session) => session.projectId === chat.currentProjectId && Boolean(session.codexSessionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (sessions.length === 0) {
    return { ok: false, reply: `No resumable sessions for project ${chat.currentProjectId}. Run /new ${chat.currentProjectId} to start one.` };
  }
  return { ok: true, chat, sessions };
}
```

Add file-level helper:

```ts
function formatResumeSessionFallback(projectId: string, sessions: SessionRecord[], timeZone: string): string {
  return [
    `Resume sessions for project ${projectId}:`,
    ...sessions.map((session) => `${session.id} | ${session.status} | ${formatDisplayTime(session.updatedAt, timeZone)}`),
    'Run /resume <session> to resume.',
  ].join('\n');
}
```

- [ ] **Step 4: Run session tests and verify GREEN**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resume has no"
```

Expected: PASS.

- [ ] **Step 5: Commit `/resume` card command**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: show resume session card"
```

## Task 4: Resume Select Card Action

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Add failing card action tests**

Append near card action tests in `tests/session/SessionManager.test.ts`:

```ts
it('resumes a current-project session from resume_select card action', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });
  await store.saveSession({
    id: 'sess_repo',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-10T07:00:00.000Z',
    updatedAt: '2026-06-10T07:10:00.000Z',
    logPath: store.sessionLogPath('sess_repo'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'resume_select', sessionId: 'sess_repo' },
  });

  expect(result.reply).toContain('Resumed session');
  expect(runner.starts[0]).toMatchObject({
    mode: { kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' },
  });
  await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
    projectId: 'repo',
    resumedFromSessionId: 'sess_repo',
    resumeSource: 'code_bot',
  });
});

it('rejects resume_select for a session outside the current project', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });
  await store.saveSession({
    id: 'sess_repo2',
    chatId: 'oc_1',
    projectId: 'repo2',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-10T07:00:00.000Z',
    updatedAt: '2026-06-10T07:10:00.000Z',
    logPath: store.sessionLogPath('sess_repo2'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'resume_select', sessionId: 'sess_repo2' },
  });

  expect(result.reply).toBe('Session sess_repo2 does not belong to current project repo.');
  expect(runner.starts).toHaveLength(0);
});
```

- [ ] **Step 2: Run card action tests and verify RED**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resume_select"
```

Expected: FAIL because `resume_select` is unsupported.

- [ ] **Step 3: Implement card action handling**

In `handleCardActionQueued`, add:

```ts
case 'resume_select':
  return this.resumeSelectedSession(authorizedInput, input.action.sessionId);
```

Add method:

```ts
private async resumeSelectedSession(input: Pick<IncomingBotText, 'chatId' | 'chatType' | 'userId'>, sessionId: string): Promise<BotTextResult> {
  const chat = await this.store.getChat(input.chatId);
  if (!chat?.currentProjectId) {
    return { reply: 'Choose a project with /projects or /use <project> before resuming a session.' };
  }
  const currentSession = chat.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  if (currentSession && isActiveSession(currentSession)) {
    return { reply: `Current session ${currentSession.id} is still running. Run /stop before resuming another session.` };
  }
  const sourceSession = await this.store.getSession(sessionId);
  if (!sourceSession || sourceSession.chatId !== input.chatId) {
    return { reply: `Session not found: ${sessionId}` };
  }
  if (sourceSession.projectId !== chat.currentProjectId) {
    return { reply: `Session ${sessionId} does not belong to current project ${chat.currentProjectId}.` };
  }
  if (!sourceSession.codexSessionId) {
    return { reply: `Session ${sessionId} cannot be resumed because no Codex session id was captured.` };
  }
  const project = resolveProject(this.config, chat.currentProjectId);
  if (!project) {
    return { reply: `Unknown project: ${chat.currentProjectId}` };
  }
  return this.startCodexSession(input, project, {
    mode: { kind: 'resume', target: sourceSession.codexSessionId },
    replyVerb: 'Resumed',
    eventType: 'session.resumed',
    sessionFields: {
      codexSessionId: sourceSession.codexSessionId,
      resumedFromSessionId: sourceSession.id,
      resumeSource: 'code_bot',
    },
  });
}
```

- [ ] **Step 4: Run card action tests and verify GREEN**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resume_select"
```

Expected: PASS.

- [ ] **Step 5: Commit card action handling**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: resume selected session from card"
```

## Task 5: Full Verification And Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README command notes**

In `README.md`, update the `/resume` command documentation to mention:

```md
- `/resume` opens a project-scoped session selector card when a project is selected.
- `/resume <session> [project]` directly resumes a code_bot or Codex native session.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npx tsc --noEmit
```

Expected: `npm test` passes all tests and `npx tsc --noEmit` exits 0.

- [ ] **Step 3: Commit docs and final verification state**

```bash
git add README.md
git commit -m "docs: document resume session selector"
```

## Self-Review

- Spec coverage: `/resume` no-arg card, project isolation, card action revalidation, menu mapping, text command compatibility, and fallback behavior are covered by the tasks above.
- Completion marker scan: no unfinished-marker text or open-ended steps remain.
- Type consistency: action kind is consistently `resume_select`; selected field is consistently `sessionId`; card renderer and parser use the same names.
