# Codex Resume Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/resume <session> [project]` so Feishu users can resume Codex native conversations through code_bot.

**Architecture:** Extend the existing session flow instead of creating a parallel lifecycle. `SessionManager` owns command semantics and chat safety; `PtyCodexRunner` owns new vs resume process launch; a new `CodexSessionRegistry` reads Codex local metadata and discovers native session ids.

**Tech Stack:** TypeScript, Vitest, node-pty, local JSON/JSONL files under `.code-bot/` and `~/.codex/`.

---

## File Structure

- Modify `src/commands/CommandRouter.ts`: add `resume` to command names.
- Modify `src/domain/types.ts`: add resume metadata to `SessionRecord`.
- Modify `src/codex/CodexRunner.ts`: add `mode` to start options and spawn `codex resume` when requested.
- Create `src/codex/CodexSessionRegistry.ts`: parse Codex session index/files and discover native session ids.
- Modify `src/session/SessionManager.ts`: implement `/resume`, discovery hooks, `/sessions` display, and help text.
- Modify `tests/helpers/fakes.ts`: record runner start options including resume mode.
- Add `tests/codex/CodexSessionRegistry.test.ts`: registry unit tests.
- Modify `tests/codex/CodexRunner.test.ts`: runner command construction tests.
- Modify `tests/commands/CommandRouter.test.ts`: parser coverage for `/resume`.
- Modify `tests/session/SessionManager.test.ts`: end-to-end command behavior tests.

---

### Task 1: Command and Type Surface

**Files:**
- Modify: `src/commands/CommandRouter.ts`
- Modify: `src/domain/types.ts`
- Test: `tests/commands/CommandRouter.test.ts`

- [ ] **Step 1: Write failing parser and type-facing tests**

Add this test to `tests/commands/CommandRouter.test.ts`:

```ts
it('parses resume command with optional project', () => {
  expect(parseIncomingText('/resume sess_1')).toEqual({
    kind: 'command',
    name: 'resume',
    args: ['sess_1'],
    raw: '/resume sess_1',
  });

  expect(parseIncomingText('/resume sess_1 chatbot')).toEqual({
    kind: 'command',
    name: 'resume',
    args: ['sess_1', 'chatbot'],
    raw: '/resume sess_1 chatbot',
  });
});
```

- [ ] **Step 2: Run test to verify it fails or typecheck fails**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
npm run build
```

Expected: parser test may pass because parser accepts any command name, but `npm run build` should fail once later switch handling references `resume` unless `CommandName` is extended. Keep the test as the behavior contract.

- [ ] **Step 3: Extend command and session types**

Update `src/commands/CommandRouter.ts`:

```ts
export type CommandName =
  | 'help'
  | 'projects'
  | 'use'
  | 'new'
  | 'resume'
  | 'send'
  | 'status'
  | 'tail'
  | 'rawtail'
  | 'stop'
  | 'sessions'
  | 'approve'
  | 'reject';
```

Update `src/domain/types.ts`:

```ts
export interface SessionRecord {
  id: string;
  chatId: string;
  projectId: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  logPath: string;
  exitCode?: number;
  lastSummary?: string;
  stopRequested?: boolean;
  codexSessionId?: string;
  resumedFromSessionId?: string;
  resumeSource?: 'code_bot' | 'codex';
}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
npm run build
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/CommandRouter.ts src/domain/types.ts tests/commands/CommandRouter.test.ts
git commit -m "feat(commands): 增加 resume 命令类型"
```

---

### Task 2: Runner Resume Mode

**Files:**
- Modify: `src/codex/CodexRunner.ts`
- Modify: `tests/helpers/fakes.ts`
- Modify: `tests/codex/CodexRunner.test.ts`

- [ ] **Step 1: Write failing runner test**

Add to `tests/codex/CodexRunner.test.ts`:

```ts
it('starts resumed session with codex resume and target after options', async () => {
  const fake = createFakeTerm();
  const spawn = vi.fn(() => fake.term as any);
  const runner = new PtyCodexRunner(
    { command: 'codex', defaultArgs: ['--ask-for-approval', 'on-request'] },
    { spawn } as any,
  );

  await runner.start({
    sessionId: 'sess-resume',
    cwd: '/tmp/project',
    args: ['--model', 'gpt-5'],
    mode: { kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' },
    onOutput: vi.fn(),
    onExit: vi.fn(),
  });

  expect(spawn).toHaveBeenCalledWith(
    'codex',
    ['resume', '--ask-for-approval', 'on-request', '--model', 'gpt-5', '019e7f20-a667-7632-a808-c9595d77116e'],
    expect.objectContaining({ cwd: '/tmp/project' }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex/CodexRunner.test.ts
```

Expected: TypeScript/Vitest fails because `mode` is not part of `CodexRunOptions` or spawn args lack `resume`.

- [ ] **Step 3: Implement start mode**

Update `src/codex/CodexRunner.ts`:

```ts
export type CodexStartMode =
  | { kind: 'new' }
  | { kind: 'resume'; target: string };

export interface CodexRunOptions {
  sessionId: string;
  cwd: string;
  args: string[];
  mode?: CodexStartMode;
  onOutput: (text: string) => void;
  onExit: (exitCode: number | undefined) => void;
}
```

Replace the spawn args in `start()`:

```ts
const mode = options.mode ?? { kind: 'new' };
const args =
  mode.kind === 'resume'
    ? ['resume', ...this.config.defaultArgs, ...options.args, mode.target]
    : [...this.config.defaultArgs, ...options.args];
const term = this.ptyModule.spawn(this.config.command, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: options.cwd,
  env: process.env,
});
```

Existing `new` mode tests should continue to expect unchanged args.

- [ ] **Step 4: Update fake runner**

In `tests/helpers/fakes.ts`, add:

```ts
  readonly starts: CodexRunOptions[] = [];
```

Inside `start()`:

```ts
    this.starts.push(options);
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/codex/CodexRunner.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/codex/CodexRunner.ts tests/codex/CodexRunner.test.ts tests/helpers/fakes.ts
git commit -m "feat(codex): 支持 resume 启动模式"
```

---

### Task 3: Codex Session Registry

**Files:**
- Create: `src/codex/CodexSessionRegistry.ts`
- Create: `tests/codex/CodexSessionRegistry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `tests/codex/CodexSessionRegistry.test.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { CodexSessionRegistry } from '../../src/codex/CodexSessionRegistry.js';

describe('CodexSessionRegistry', () => {
  it('reads session index entries', async () => {
    const root = await createTmpDir();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'session_index.jsonl'),
      '{"id":"019e7f20-a667-7632-a808-c9595d77116e","thread_name":"resume work","updated_at":"2026-06-01T10:00:00.000Z"}\n',
      'utf8',
    );

    const registry = new CodexSessionRegistry(root);

    await expect(registry.listIndexEntries()).resolves.toEqual([
      {
        id: '019e7f20-a667-7632-a808-c9595d77116e',
        threadName: 'resume work',
        updatedAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
  });

  it('discovers a unique session by project path and start time', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(root, 'session_index.jsonl'), '', 'utf8');
    await writeFile(
      join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl'),
      '{"timestamp":"2026-06-01T10:00:02.000Z","cwd":"/tmp/project"}\n',
      'utf8',
    );

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' });
  });

  it('returns ambiguous when multiple candidates match', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(root, 'session_index.jsonl'), '', 'utf8');
    await writeFile(
      join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl'),
      '{"timestamp":"2026-06-01T10:00:02.000Z","cwd":"/tmp/project"}\n',
      'utf8',
    );
    await writeFile(
      join(sessionDir, 'rollout-2026-06-01T10-00-03-019e7f21-a667-7632-a808-c9595d77116e.jsonl'),
      '{"timestamp":"2026-06-01T10:00:03.000Z","cwd":"/tmp/project"}\n',
      'utf8',
    );

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: false, reason: 'ambiguous' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex/CodexSessionRegistry.test.ts
```

Expected: fails because module does not exist.

- [ ] **Step 3: Implement registry**

Create `src/codex/CodexSessionRegistry.ts`:

```ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface CodexIndexEntry {
  id: string;
  threadName?: string;
  updatedAt: string;
}

export interface DiscoverRequest {
  projectPath: string;
  startedAt: string;
}

export type DiscoverResult =
  | { ok: true; codexSessionId: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' };

const CODEX_UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export class CodexSessionRegistry {
  constructor(private readonly codexHome: string) {}

  async listIndexEntries(): Promise<CodexIndexEntry[]> {
    let content: string;
    try {
      content = await readFile(join(this.codexHome, 'session_index.jsonl'), 'utf8');
    } catch {
      return [];
    }
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; thread_name?: string; updated_at: string })
      .map((entry) => ({ id: entry.id, threadName: entry.thread_name, updatedAt: entry.updated_at }));
  }

  async discoverForProject(request: DiscoverRequest): Promise<DiscoverResult> {
    const files = await this.listSessionFiles(join(this.codexHome, 'sessions'));
    const startedAtMs = Date.parse(request.startedAt);
    const candidates: string[] = [];

    for (const filePath of files) {
      const id = this.extractId(filePath);
      if (!id) {
        continue;
      }
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < startedAtMs) {
        continue;
      }
      const content = await readFile(filePath, 'utf8');
      if (!content.includes(request.projectPath)) {
        continue;
      }
      candidates.push(id);
    }

    const unique = [...new Set(candidates)];
    if (unique.length === 1) {
      return { ok: true, codexSessionId: unique[0] };
    }
    return { ok: false, reason: unique.length === 0 ? 'not-found' : 'ambiguous' };
  }

  private extractId(filePath: string): string | undefined {
    return filePath.match(CODEX_UUID_PATTERN)?.[0];
  }

  private async listSessionFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listSessionFiles(child)));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(child);
      }
    }
    return files;
  }
}
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/codex/CodexSessionRegistry.test.ts
npm run build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/CodexSessionRegistry.ts tests/codex/CodexSessionRegistry.test.ts
git commit -m "feat(codex): 读取 Codex 会话元数据"
```

---

### Task 4: SessionManager Dependencies and `/new` Discovery Hook

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing tests for `/new` codex id binding**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('records discovered Codex session id after /new', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const registry = {
    discoverForProject: vi.fn().mockResolvedValue({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' }),
  };
  const manager = new SessionManager(sampleConfig(root), store, runner, { codexSessionRegistry: registry as any });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

  await expect(store.getSession(sessionId)).resolves.toMatchObject({
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });
  expect(registry.discoverForProject).toHaveBeenCalledWith(expect.objectContaining({ projectPath: root }));
});
```

Also update the import line to include `vi`:

```ts
import { describe, expect, it, vi } from 'vitest';
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "records discovered Codex session id"
```

Expected: fails because constructor does not accept `codexSessionRegistry` and `/new` does not discover.

- [ ] **Step 3: Add optional SessionManager dependencies**

In `src/session/SessionManager.ts`, import registry type:

```ts
import { CodexSessionRegistry } from '../codex/CodexSessionRegistry.js';
```

Add interfaces near constructor:

```ts
interface CodexSessionDiscovery {
  discoverForProject(request: { projectPath: string; startedAt: string }): Promise<
    | { ok: true; codexSessionId: string }
    | { ok: false; reason: 'not-found' | 'ambiguous' }
  >;
}

interface SessionManagerDeps {
  codexSessionRegistry?: CodexSessionDiscovery;
}
```

Change constructor:

```ts
  constructor(
    private readonly config: BotConfig,
    private readonly store: FileStateStore,
    private readonly runner: CodexRunner,
    private readonly deps: SessionManagerDeps = {},
  ) {
    this.approvalManager = new ApprovalManager(store);
  }
```

Use a default registry only when needed:

```ts
  private codexSessionRegistry(): CodexSessionDiscovery | undefined {
    return this.deps.codexSessionRegistry ?? new CodexSessionRegistry(process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`);
  }
```

- [ ] **Step 4: Bind Codex id after successful `/new` start**

In `createSession()`, record `startedAt` before `runner.start()`:

```ts
const startedAt = new Date().toISOString();
```

After `session.created` event and before saving chat or returning, call:

```ts
await this.discoverAndStoreCodexSessionId(sessionId, project.path, startedAt);
```

Add helper:

```ts
  private async discoverAndStoreCodexSessionId(sessionId: string, projectPath: string, startedAt: string): Promise<void> {
    const registry = this.codexSessionRegistry();
    if (!registry) {
      return;
    }
    const result = await registry.discoverForProject({ projectPath, startedAt });
    if (result.ok) {
      await this.store.updateSession(sessionId, (latest) => ({
        ...latest,
        codexSessionId: result.codexSessionId,
        updatedAt: new Date().toISOString(),
      }));
      await this.store.appendEvent({
        type: 'session.codex_id_discovered',
        at: new Date().toISOString(),
        data: { sessionId, codexSessionId: result.codexSessionId },
      });
      return;
    }
    await this.store.appendEvent({
      type: 'session.codex_id_discovery_failed',
      at: new Date().toISOString(),
      data: { sessionId, reason: result.reason },
    });
  }
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "records discovered Codex session id"
npm run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat(session): 记录 Codex 原生会话 ID"
```

---

### Task 5: Implement `/resume` Command Behavior

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing tests for successful resume paths**

Add tests:

```ts
it('resumes from a code_bot session id with a known Codex id', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });
  await store.saveSession({
    id: 'sess_old',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:01:00.000Z',
    logPath: store.sessionLogPath('sess_old'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume sess_old' });
  const currentSessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const currentSession = await store.getSession(currentSessionId);

  expect(result.reply).toBe(`Resumed Codex session for project repo as ${currentSessionId}.`);
  expect(currentSession).toMatchObject({
    projectId: 'repo',
    status: 'running',
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
    resumedFromSessionId: 'sess_old',
    resumeSource: 'code_bot',
  });
  expect(runner.starts.at(-1)?.mode).toEqual({ kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' });
});

it('resumes from a Codex native id and explicit project', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  const result = await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    text: '/resume 019e7f20-a667-7632-a808-c9595d77116e repo',
  });
  const currentSessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const currentSession = await store.getSession(currentSessionId);

  expect(result.reply).toBe(`Resumed Codex session for project repo as ${currentSessionId}.`);
  expect(currentSession).toMatchObject({ projectId: 'repo', resumeSource: 'codex' });
  expect(runner.starts.at(-1)?.mode).toEqual({ kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resumes"
```

Expected: fails because `/resume` is unknown.

- [ ] **Step 3: Add switch case and help text**

In `handleTextQueued()`:

```ts
      case 'resume':
        return this.resumeSession(input, parsed.args[0], parsed.args[1]);
```

In `helpText()` command list add:

```text
/resume <session> [project]
```

- [ ] **Step 4: Implement resumeSession**

Add method to `SessionManager`:

```ts
  private async resumeSession(input: IncomingBotText, resumeTarget?: string, projectId?: string): Promise<BotTextResult> {
    if (!resumeTarget) {
      return { reply: 'Usage: /resume <session> [project]' };
    }

    const previousChat = await this.store.getChat(input.chatId);
    const previousSession = previousChat?.currentSessionId ? await this.store.getSession(previousChat.currentSessionId) : undefined;
    if (previousSession && isActiveSession(previousSession)) {
      return {
        reply: `Current session ${previousSession.id} is still running. Run /stop and approve it before resuming another session.`,
      };
    }

    const selectedProjectId = projectId ?? previousChat?.currentProjectId;
    if (!selectedProjectId) {
      return { reply: 'Choose a project with /projects and /use <project>, or run /resume <session> <project>.' };
    }
    const project = resolveProject(this.config, selectedProjectId);
    if (!project) {
      return { reply: `Unknown project: ${selectedProjectId}` };
    }

    const source = await this.resolveResumeTarget(input.chatId, resumeTarget, project.path);
    if ('reply' in source) {
      return source;
    }

    return this.startCodexSession({
      input,
      project,
      mode: { kind: 'resume', target: source.codexTarget },
      resumeMetadata: source.resumeMetadata,
      failureVerb: 'resume',
    });
  }
```

Add helper return type and `resolveResumeTarget()`:

```ts
  private async resolveResumeTarget(chatId: string, target: string, projectPath: string): Promise<
    | { codexTarget: string; resumeMetadata: Pick<SessionRecord, 'codexSessionId' | 'resumedFromSessionId' | 'resumeSource'> }
    | BotTextResult
  > {
    const sourceSession = await this.store.getSession(target);
    if (!sourceSession) {
      return { codexTarget: target, resumeMetadata: { resumeSource: 'codex' } };
    }
    if (sourceSession.chatId !== chatId) {
      return { reply: `Unknown session for this chat: ${target}` };
    }
    let codexSessionId = sourceSession.codexSessionId;
    if (!codexSessionId) {
      await this.discoverAndStoreCodexSessionId(sourceSession.id, projectPath, sourceSession.createdAt);
      codexSessionId = (await this.store.getSession(sourceSession.id))?.codexSessionId;
    }
    if (!codexSessionId) {
      return { reply: `Session ${target} is not resumable yet. Use /rawtail to inspect logs or resume with a Codex session id.` };
    }
    return {
      codexTarget: codexSessionId,
      resumeMetadata: {
        codexSessionId,
        resumedFromSessionId: sourceSession.id,
        resumeSource: 'code_bot',
      },
    };
  }
```

To avoid duplicating `/new` and `/resume` start logic, extract `startCodexSession()` from existing `createSession()` in this task. It should accept project, mode, optional resume metadata, and failure verb.

- [ ] **Step 5: Verify successful paths**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resumes"
npm run build
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat(session): 支持 resume 启动会话"
```

---

### Task 6: Resume Error Cases and Chat Safety

**Files:**
- Modify: `tests/session/SessionManager.test.ts`
- Modify: `src/session/SessionManager.ts`

- [ ] **Step 1: Write failing error-case tests**

Add tests:

```ts
it('rejects /resume while current session is active', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const activeId = (await store.getChat('oc_1'))!.currentSessionId!;

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume anything repo' });

  expect(result.reply).toBe(`Current session ${activeId} is still running. Run /stop and approve it before resuming another session.`);
});

it('requires a project for native resume when chat has no current project', async () => {
  const root = await createTmpDir();
  const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume 019e7f20-a667-7632-a808-c9595d77116e' });

  expect(result.reply).toBe('Choose a project with /projects and /use <project>, or run /resume <session> <project>.');
});

it('rejects code_bot session ids from another chat', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });
  await store.saveSession({
    id: 'sess_other',
    chatId: 'oc_2',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:01:00.000Z',
    logPath: store.sessionLogPath('sess_other'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume sess_other' });

  expect(result.reply).toBe('Unknown session for this chat: sess_other');
});

it('does not switch current session when resume start fails', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  runner.startError = new Error('spawn failed');
  const manager = new SessionManager(sampleConfig(root), store, runner);

  const result = await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    text: '/resume 019e7f20-a667-7632-a808-c9595d77116e repo',
  });

  expect(result.reply).toBe('Failed to resume Codex session for project repo: spawn failed');
  expect((await store.getChat('oc_1'))?.currentSessionId).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resume"
```

Expected: new error cases fail until implementation handles them exactly.

- [ ] **Step 3: Complete error handling**

Ensure implementation returns exact strings from tests. In shared start helper, use:

```ts
const failurePrefix = failureVerb === 'resume' ? 'Failed to resume Codex' : 'Failed to start Codex';
```

For resume failure, return:

```ts
return { reply: `Failed to resume Codex session for project ${project.id}: ${message}` };
```

Do not call `saveChat()` with the failed session id when runner start throws.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "resume"
npm run build
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "fix(session): 完善 resume 错误处理"
```

---

### Task 7: `/sessions` and `/help` Display

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing display tests**

Add to existing `/sessions` test or add a new one:

```ts
it('shows current resumable markers in /sessions and documents /resume in help', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: 'sess_current' });
  await store.saveSession({
    id: 'sess_current',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'running',
    createdBy: 'ou_1',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:03:00.000Z',
    logPath: store.sessionLogPath('sess_current'),
    codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
  });
  await store.saveSession({
    id: 'sess_old',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'exited',
    createdBy: 'ou_1',
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:03:00.000Z',
    logPath: store.sessionLogPath('sess_old'),
    codexSessionId: '019e7f21-a667-7632-a808-c9595d77116e',
  });
  await store.saveSession({
    id: 'sess_plain',
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'interrupted',
    createdBy: 'ou_1',
    createdAt: '2026-06-01T08:00:00.000Z',
    updatedAt: '2026-06-01T08:03:00.000Z',
    logPath: store.sessionLogPath('sess_plain'),
  });

  const sessions = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/sessions' });
  expect(sessions.reply).toContain('sess_current | repo | running | current |');
  expect(sessions.reply).toContain('sess_old | repo | exited | resumable |');
  expect(sessions.reply).toContain('sess_plain | repo | interrupted | not-resumable |');

  const help = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/help' });
  expect(help.reply).toContain('/resume <session> [project]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "shows current resumable markers"
```

Expected: fails because marker and help text are missing.

- [ ] **Step 3: Implement display**

Update `sessions()`:

```ts
    const chat = await this.store.getChat(chatId);
    return {
      reply: sessions
        .map((session) => {
          const marker =
            chat?.currentSessionId === session.id ? 'current' : session.codexSessionId ? 'resumable' : 'not-resumable';
          return `${session.id} | ${session.projectId} | ${session.status} | ${marker} | ${session.updatedAt}`;
        })
        .join('\n'),
    };
```

Update `helpText()`:

```ts
const commands = '/help\n/projects\n/use <project>\n/new [project]\n/resume <session> [project]\n/send <text>\n/status\n/tail [n]\n/rawtail [n]\n/stop\n/sessions\n/approve <id>\n/reject <id>';
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "shows current resumable markers"
npm test -- tests/session/SessionManager.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat(session): 展示 resume 可用状态"
```

---

### Task 8: Documentation and Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README command list**

Add `/resume` to the command list in `README.md`:

```text
/resume <session> [project]
```

Add a command note:

```markdown
- `/resume <session> [project]` resumes a Codex native conversation as a new code_bot session. `<session>` may be a code_bot session id from `/sessions` when it is marked `resumable`, or a Codex native session id/thread name. If `[project]` is omitted, the current project selected by `/use` is used.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run build
git status --short
```

Expected:

- `npm test`: all tests pass.
- `npm run build`: passes.
- `git status --short`: only README is modified before commit.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): 说明 resume 命令"
```

---

## Final Review Checklist

- [ ] `/resume` works with code_bot session id.
- [ ] `/resume` works with Codex native id/thread token.
- [ ] `/resume` refuses when a current session is active.
- [ ] `/resume` never accepts arbitrary project paths.
- [ ] `/new` attempts to bind `codexSessionId`.
- [ ] `/sessions` shows `current`, `resumable`, and `not-resumable`.
- [ ] `/help` and README document `/resume`.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
