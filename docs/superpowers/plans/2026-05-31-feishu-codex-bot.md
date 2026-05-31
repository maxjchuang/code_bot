# Feishu Codex Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript Feishu long-connection bot that controls local Codex CLI sessions across allowlisted project directories.

**Architecture:** Implement one Bot Agent process with focused modules for Feishu gateway, command routing, session orchestration, Codex process control, approvals, output formatting, and file persistence. Keep external integrations behind interfaces so the core flow can be tested with fake Feishu and fake Codex adapters.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, `@larksuiteoapi/node-sdk`, `node-pty`, native `node:fs/promises`, native `node:events`.

---

## File Map

- Create `package.json`: npm scripts and runtime/dev dependencies.
- Create `tsconfig.json`: strict TypeScript settings for Node.
- Create `vitest.config.ts`: unit and integration test config.
- Create `.gitignore`: ignore dependencies, build output, local bot state, and companion artifacts.
- Create `src/domain/types.ts`: shared domain types and interfaces.
- Create `src/config/loadConfig.ts`: load and validate `.code-bot/config.json`.
- Create `src/state/FileStateStore.ts`: snapshot JSON, JSONL events, session logs, and serialized writes.
- Create `src/commands/CommandRouter.ts`: slash command parsing and normal text routing.
- Create `src/security/guards.ts`: user/chat/project allowlist checks and safe project resolution.
- Create `src/output/OutputFormatter.ts`: chunking, summary decisions, and tail formatting.
- Create `src/approvals/ApprovalManager.ts`: approval records, expiration, card payload creation, and text fallback state.
- Create `src/codex/CodexRunner.ts`: `CodexRunner` interface and pty-backed CLI implementation.
- Create `src/session/SessionManager.ts`: command handling and session lifecycle coordination.
- Create `src/feishu/FeishuGateway.ts`: Feishu long-connection adapter behind a small interface.
- Create `src/app/createApp.ts`: dependency wiring.
- Create `src/index.ts`: CLI entry point.
- Create `tests/helpers/tmp.ts`: temporary directory helper.
- Create `tests/helpers/fakes.ts`: fake Feishu gateway and fake Codex runner.
- Create tests next to each module under `tests/**/*.test.ts`.

## Task 1: TypeScript Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Write the scaffold files**

`package.json`:

```json
{
  "name": "code-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.49.0",
    "node-pty": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    clearMocks: true,
  },
});
```

`.gitignore`:

```gitignore
node_modules/
dist/
.code-bot/
.superpowers/
*.log
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and install exits with code 0.

- [ ] **Step 3: Verify empty project scripts**

Run:

```bash
npm run build
npm test
```

Expected: build succeeds; Vitest exits successfully with no tests.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore(scaffold): 初始化 TypeScript 项目"
```

## Task 2: Domain Types and Config Loader

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/config/loadConfig.ts`
- Create: `tests/config/loadConfig.test.ts`

- [ ] **Step 1: Write failing config tests**

`tests/config/loadConfig.test.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { loadConfig } from '../../src/config/loadConfig.js';

describe('loadConfig', () => {
  it('loads a valid bot config', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(
      join(root, '.code-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: ['oc_group_1'],
        projects: [
          { id: 'repo', name: 'Repo', path: root, codexArgs: ['--ask-for-approval', 'on-request'] }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    const config = await loadConfig(root);

    expect(config.projects[0].id).toBe('repo');
    expect(config.output.directMaxChars).toBe(1800);
  });

  it('rejects duplicate project ids', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(
      join(root, '.code-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: [],
        projects: [
          { id: 'repo', name: 'Repo A', path: root },
          { id: 'repo', name: 'Repo B', path: root }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    await expect(loadConfig(root)).rejects.toThrow('Duplicate project id: repo');
  });
});
```

Also create `tests/helpers/tmp.ts`:

```ts
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-bot-'));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts
```

Expected: FAIL because `src/config/loadConfig.ts` does not exist.

- [ ] **Step 3: Implement domain types and loader**

`src/domain/types.ts`:

```ts
export type ChatType = 'private' | 'group';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'interrupted' | 'unknown';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  codexArgs: string[];
}

export interface BotConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  allowedUsers: string[];
  allowedChatIds: string[];
  projects: ProjectConfig[];
  output: {
    directMaxChars: number;
    chunkSize: number;
  };
  codex: {
    command: string;
    defaultArgs: string[];
  };
}

export interface ChatContext {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  currentSessionId?: string;
}

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
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  chatId: string;
  requestedBy: string;
  status: ApprovalStatus;
  riskSummary: string;
  createdAt: string;
  expiresAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface BotEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}
```

`src/config/loadConfig.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BotConfig, ProjectConfig } from '../domain/types.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function normalizeProject(value: unknown): ProjectConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid config field: projects');
  }
  const item = value as Record<string, unknown>;
  return {
    id: requireString(item.id, 'projects[].id'),
    name: requireString(item.name, 'projects[].name'),
    path: resolve(requireString(item.path, 'projects[].path')),
    codexArgs: item.codexArgs === undefined ? [] : requireStringArray(item.codexArgs, 'projects[].codexArgs'),
  };
}

export async function loadConfig(projectRoot: string): Promise<BotConfig> {
  const raw = JSON.parse(await readFile(resolve(projectRoot, '.code-bot/config.json'), 'utf8')) as Record<string, unknown>;
  const feishu = raw.feishu as Record<string, unknown> | undefined;
  const output = raw.output as Record<string, unknown> | undefined;
  const codex = raw.codex as Record<string, unknown> | undefined;
  if (!feishu || !output || !codex || !Array.isArray(raw.projects)) {
    throw new Error('Invalid config structure');
  }

  const projects = raw.projects.map(normalizeProject);
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    ids.add(project.id);
  }

  return {
    feishu: {
      appId: requireString(feishu.appId, 'feishu.appId'),
      appSecret: requireString(feishu.appSecret, 'feishu.appSecret'),
    },
    allowedUsers: requireStringArray(raw.allowedUsers, 'allowedUsers'),
    allowedChatIds: requireStringArray(raw.allowedChatIds, 'allowedChatIds'),
    projects,
    output: {
      directMaxChars: requirePositiveNumber(output.directMaxChars, 'output.directMaxChars'),
      chunkSize: requirePositiveNumber(output.chunkSize, 'output.chunkSize'),
    },
    codex: {
      command: requireString(codex.command, 'codex.command'),
      defaultArgs: codex.defaultArgs === undefined ? [] : requireStringArray(codex.defaultArgs, 'codex.defaultArgs'),
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/config/loadConfig.ts tests/config/loadConfig.test.ts tests/helpers/tmp.ts
git commit -m "feat(config): 加载并校验机器人配置"
```

## Task 3: File State Store

**Files:**
- Create: `src/state/FileStateStore.ts`
- Create: `tests/state/FileStateStore.test.ts`

- [ ] **Step 1: Write failing persistence tests**

`tests/state/FileStateStore.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';

describe('FileStateStore', () => {
  it('writes chat snapshots atomically and reads them back', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    await expect(store.getChat('oc_1')).resolves.toEqual({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
    });
  });

  it('appends audit events as json lines', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-05-31T10:00:00.000Z'));
    await store.appendEvent({ type: 'command.received', at: '2026-05-31T10:00:00.000Z', data: { command: '/status' } });

    const events = await readFile(join(root, '.code-bot/events/2026-05-31.jsonl'), 'utf8');

    expect(events.trim()).toBe(JSON.stringify({
      type: 'command.received',
      at: '2026-05-31T10:00:00.000Z',
      data: { command: '/status' },
    }));
  });

  it('stores and tails session logs', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_1', 'one\\n');
    await store.appendSessionLog('session_1', 'two\\nthree\\n');

    await expect(store.tailSessionLog('session_1', 2)).resolves.toEqual(['two', 'three']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/state/FileStateStore.test.ts
```

Expected: FAIL because `FileStateStore` does not exist.

- [ ] **Step 3: Implement FileStateStore**

`src/state/FileStateStore.ts`:

```ts
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ApprovalRecord, BotEvent, ChatContext, SessionRecord } from '../domain/types.js';

type Clock = () => Date;

export class FileStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly baseDir: string;

  constructor(projectRoot: string, private readonly clock: Clock = () => new Date()) {
    this.baseDir = join(projectRoot, '.code-bot');
  }

  async saveChat(chat: ChatContext): Promise<void> {
    await this.writeJson(join(this.baseDir, 'state/chats', `${chat.chatId}.json`), chat);
  }

  async getChat(chatId: string): Promise<ChatContext | undefined> {
    return this.readJson<ChatContext>(join(this.baseDir, 'state/chats', `${chatId}.json`));
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await this.writeJson(join(this.baseDir, 'state/sessions', `${session.id}.json`), session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.readJson<SessionRecord>(join(this.baseDir, 'state/sessions', `${sessionId}.json`));
  }

  async saveApproval(approval: ApprovalRecord): Promise<void> {
    await this.writeJson(join(this.baseDir, 'state/approvals', `${approval.id}.json`), approval);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.readJson<ApprovalRecord>(join(this.baseDir, 'state/approvals', `${approvalId}.json`));
  }

  async appendEvent(event: BotEvent): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    await this.enqueue(async () => {
      const filePath = join(this.baseDir, 'events', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  async appendSessionLog(sessionId: string, text: string): Promise<void> {
    await this.enqueue(async () => {
      const filePath = this.sessionLogPath(sessionId);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, text, 'utf8');
    });
  }

  async tailSessionLog(sessionId: string, lineCount: number): Promise<string[]> {
    try {
      const content = await readFile(this.sessionLogPath(sessionId), 'utf8');
      return content.split(/\r?\n/).filter((line) => line.length > 0).slice(-lineCount);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  sessionLogPath(sessionId: string): string {
    return join(this.baseDir, 'logs/sessions', `${sessionId}.log`);
  }

  private async readJson<T>(filePath: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(tmpPath, filePath);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/state/FileStateStore.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/FileStateStore.ts tests/state/FileStateStore.test.ts
git commit -m "feat(state): 添加文件状态存储"
```

## Task 4: Command Router

**Files:**
- Create: `src/commands/CommandRouter.ts`
- Create: `tests/commands/CommandRouter.test.ts`

- [ ] **Step 1: Write failing command parsing tests**

`tests/commands/CommandRouter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseIncomingText } from '../../src/commands/CommandRouter.js';

describe('parseIncomingText', () => {
  it('parses slash commands with arguments', () => {
    expect(parseIncomingText('/new repo')).toEqual({ kind: 'command', name: 'new', args: ['repo'], raw: '/new repo' });
    expect(parseIncomingText('/tail 120')).toEqual({ kind: 'command', name: 'tail', args: ['120'], raw: '/tail 120' });
  });

  it('treats non-command text as codex input', () => {
    expect(parseIncomingText('please inspect this repo')).toEqual({ kind: 'message', text: 'please inspect this repo' });
  });

  it('preserves send payload after command name', () => {
    expect(parseIncomingText('/send explain /status literally')).toEqual({
      kind: 'command',
      name: 'send',
      args: ['explain /status literally'],
      raw: '/send explain /status literally',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
```

Expected: FAIL because `CommandRouter` does not exist.

- [ ] **Step 3: Implement parser**

`src/commands/CommandRouter.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/CommandRouter.ts tests/commands/CommandRouter.test.ts
git commit -m "feat(commands): 解析飞书文本命令"
```

## Task 5: Security Guards and Project Resolution

**Files:**
- Create: `src/security/guards.ts`
- Create: `tests/security/guards.test.ts`

- [ ] **Step 1: Write failing security tests**

`tests/security/guards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isAuthorizedMessage, resolveProject } from '../../src/security/guards.js';
import type { BotConfig } from '../../src/domain/types.js';

const config: BotConfig = {
  feishu: { appId: 'cli', appSecret: 'secret' },
  allowedUsers: ['ou_1'],
  allowedChatIds: ['oc_1'],
  projects: [{ id: 'repo', name: 'Repo', path: '/tmp/repo', codexArgs: [] }],
  output: { directMaxChars: 1800, chunkSize: 1500 },
  codex: { command: 'codex', defaultArgs: [] },
};

describe('security guards', () => {
  it('allows private messages from allowlisted users', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'ou_1', chatType: 'private' })).toBe(true);
  });

  it('blocks group messages outside the chat allowlist', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'oc_other', chatType: 'group' })).toBe(false);
  });

  it('resolves projects by id only', () => {
    expect(resolveProject(config, 'repo')?.path).toBe('/tmp/repo');
    expect(resolveProject(config, '/tmp/repo')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/security/guards.test.ts
```

Expected: FAIL because guards do not exist.

- [ ] **Step 3: Implement guards**

`src/security/guards.ts`:

```ts
import type { BotConfig, ChatType, ProjectConfig } from '../domain/types.js';

export interface IncomingPrincipal {
  userId: string;
  chatId: string;
  chatType: ChatType;
}

export function isAuthorizedMessage(config: BotConfig, principal: IncomingPrincipal): boolean {
  if (!config.allowedUsers.includes(principal.userId)) {
    return false;
  }
  if (principal.chatType === 'private') {
    return true;
  }
  return config.allowedChatIds.includes(principal.chatId);
}

export function resolveProject(config: BotConfig, projectId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.id === projectId);
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/security/guards.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/security/guards.ts tests/security/guards.test.ts
git commit -m "feat(security): 添加用户和项目访问校验"
```

## Task 6: Output Formatter

**Files:**
- Create: `src/output/OutputFormatter.ts`
- Create: `tests/output/OutputFormatter.test.ts`

- [ ] **Step 1: Write failing output tests**

`tests/output/OutputFormatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatOutput, formatTail } from '../../src/output/OutputFormatter.js';

describe('OutputFormatter', () => {
  it('returns direct output when text is short', () => {
    expect(formatOutput('done', { directMaxChars: 10, chunkSize: 5 })).toEqual({ kind: 'direct', chunks: ['done'] });
  });

  it('chunks long output', () => {
    expect(formatOutput('abcdefghijkl', { directMaxChars: 5, chunkSize: 4 })).toEqual({
      kind: 'summary',
      chunks: ['abcd', 'efgh', 'ijkl'],
      summary: 'Output is 12 characters across 3 chunks. Use /tail to inspect local logs.',
    });
  });

  it('formats tail lines', () => {
    expect(formatTail(['one', 'two'])).toBe('```text\\none\\ntwo\\n```');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/output/OutputFormatter.test.ts
```

Expected: FAIL because formatter does not exist.

- [ ] **Step 3: Implement formatter**

`src/output/OutputFormatter.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/output/OutputFormatter.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/output/OutputFormatter.ts tests/output/OutputFormatter.test.ts
git commit -m "feat(output): 格式化 Codex 输出"
```

## Task 7: Codex Runner Interface and Pty Implementation

**Files:**
- Create: `src/codex/CodexRunner.ts`
- Create: `tests/codex/CodexRunner.test.ts`

- [ ] **Step 1: Write failing fake-runner tests**

`tests/codex/CodexRunner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createCodexSessionId, PtyCodexRunner } from '../../src/codex/CodexRunner.js';

describe('CodexRunner helpers', () => {
  it('creates stable prefixed session ids', () => {
    expect(createCodexSessionId('abc123').startsWith('sess_abc123_')).toBe(true);
  });
});

describe('PtyCodexRunner', () => {
  it('reports missing codex command through health check', async () => {
    const runner = new PtyCodexRunner({ command: 'definitely-missing-codex-command', defaultArgs: [] });
    await expect(runner.healthCheck()).resolves.toEqual({ ok: false, reason: 'Command not found: definitely-missing-codex-command' });
  });

  it('can be constructed with codex command', () => {
    const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] });
    expect(runner).toBeInstanceOf(PtyCodexRunner);
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/codex/CodexRunner.test.ts
```

Expected: FAIL because `CodexRunner` does not exist.

- [ ] **Step 3: Implement runner interface and pty class**

`src/codex/CodexRunner.ts`:

```ts
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import pty from 'node-pty';

export interface CodexRunOptions {
  sessionId: string;
  cwd: string;
  args: string[];
  onOutput: (text: string) => void;
  onExit: (exitCode: number | undefined) => void;
}

export interface CodexRunner {
  healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
  start(options: CodexRunOptions): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
}

export function createCodexSessionId(seed: string = Math.random().toString(36).slice(2)): string {
  return `sess_${seed}_${Date.now().toString(36)}`;
}

export class PtyCodexRunner implements CodexRunner {
  private readonly processes = new Map<string, pty.IPty>();

  constructor(private readonly config: { command: string; defaultArgs: string[] }) {}

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const found = await findExecutable(this.config.command);
    return found ? { ok: true } : { ok: false, reason: `Command not found: ${this.config.command}` };
  }

  async start(options: CodexRunOptions): Promise<void> {
    const term = pty.spawn(this.config.command, [...this.config.defaultArgs, ...options.args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: process.env,
    });
    this.processes.set(options.sessionId, term);
    term.onData(options.onOutput);
    term.onExit((event) => {
      this.processes.delete(options.sessionId);
      options.onExit(event.exitCode);
    });
  }

  async send(sessionId: string, text: string): Promise<void> {
    const term = this.requireProcess(sessionId);
    term.write(`${text}\r`);
  }

  async stop(sessionId: string): Promise<void> {
    const term = this.requireProcess(sessionId);
    term.kill();
    this.processes.delete(sessionId);
  }

  private requireProcess(sessionId: string): pty.IPty {
    const term = this.processes.get(sessionId);
    if (!term) {
      throw new Error(`Codex session is not running: ${sessionId}`);
    }
    return term;
  }
}

async function findExecutable(command: string): Promise<boolean> {
  if (isAbsolute(command)) {
    return canExecute(command);
  }
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of paths) {
    if (await canExecute(`${dir}/${command}`)) {
      return true;
    }
  }
  return false;
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/codex/CodexRunner.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/CodexRunner.ts tests/codex/CodexRunner.test.ts
git commit -m "feat(codex): 添加 Codex CLI 运行器"
```

## Task 8: Approval Manager

**Files:**
- Create: `src/approvals/ApprovalManager.ts`
- Create: `tests/approvals/ApprovalManager.test.ts`

- [ ] **Step 1: Write failing approval tests**

`tests/approvals/ApprovalManager.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { ApprovalManager } from '../../src/approvals/ApprovalManager.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('ApprovalManager', () => {
  it('creates and approves approval records', async () => {
    const store = new FileStateStore(await createTmpDir());
    const manager = new ApprovalManager(store, () => new Date('2026-05-31T10:00:00.000Z'));

    const approval = await manager.requestApproval({
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      riskSummary: 'Stop running session',
      ttlMs: 60000,
    });

    expect(approval.status).toBe('pending');
    expect(manager.buildTextFallback(approval)).toContain(`/approve ${approval.id}`);

    const approved = await manager.resolve(approval.id, 'approved', 'ou_1');
    expect(approved.status).toBe('approved');
    expect(approved.resolvedBy).toBe('ou_1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/approvals/ApprovalManager.test.ts
```

Expected: FAIL because `ApprovalManager` does not exist.

- [ ] **Step 3: Implement ApprovalManager**

`src/approvals/ApprovalManager.ts`:

```ts
import type { ApprovalRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';

type Clock = () => Date;

export interface ApprovalRequest {
  sessionId: string;
  chatId: string;
  requestedBy: string;
  riskSummary: string;
  ttlMs: number;
}

export class ApprovalManager {
  constructor(private readonly store: FileStateStore, private readonly clock: Clock = () => new Date()) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalRecord> {
    const now = this.clock();
    const approval: ApprovalRecord = {
      id: `appr_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: request.sessionId,
      chatId: request.chatId,
      requestedBy: request.requestedBy,
      status: 'pending',
      riskSummary: request.riskSummary,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    };
    await this.store.saveApproval(approval);
    await this.store.appendEvent({ type: 'approval.created', at: approval.createdAt, data: { approvalId: approval.id, sessionId: approval.sessionId } });
    return approval;
  }

  async resolve(approvalId: string, status: 'approved' | 'rejected', userId: string): Promise<ApprovalRecord> {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }
    if (approval.status !== 'pending') {
      throw new Error(`Approval is not pending: ${approvalId}`);
    }
    const resolved: ApprovalRecord = {
      ...approval,
      status,
      resolvedBy: userId,
      resolvedAt: this.clock().toISOString(),
    };
    await this.store.saveApproval(resolved);
    await this.store.appendEvent({ type: `approval.${status}`, at: resolved.resolvedAt, data: { approvalId, userId } });
    return resolved;
  }

  buildTextFallback(approval: ApprovalRecord): string {
    return [
      `Approval required: ${approval.riskSummary}`,
      `Session: ${approval.sessionId}`,
      `Expires: ${approval.expiresAt}`,
      `Approve: /approve ${approval.id}`,
      `Reject: /reject ${approval.id}`,
    ].join('\n');
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/approvals/ApprovalManager.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/approvals/ApprovalManager.ts tests/approvals/ApprovalManager.test.ts
git commit -m "feat(approval): 管理远程操作审批"
```

## Task 9: Session Manager Core Flow

**Files:**
- Create: `src/session/SessionManager.ts`
- Create: `tests/helpers/fakes.ts`
- Create: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing session tests**

`tests/session/SessionManager.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { createTmpDir } from '../helpers/tmp.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';

describe('SessionManager', () => {
  it('creates a session and sends normal messages to Codex', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const created = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(created.reply).toContain('Created session');

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'inspect status',
    });
    expect(sent.reply).toContain('Sent to Codex');
    expect(runner.sentMessages).toEqual(['inspect status']);
  });

  it('blocks unauthorized users', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    const result = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_blocked',
      text: '/status',
    });

    expect(result.reply).toBe('You are not allowed to control this bot.');
  });
});
```

`tests/helpers/fakes.ts`:

```ts
import type { BotConfig } from '../../src/domain/types.js';
import type { CodexRunOptions, CodexRunner } from '../../src/codex/CodexRunner.js';

export function sampleConfig(projectPath: string): BotConfig {
  return {
    feishu: { appId: 'cli', appSecret: 'secret' },
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    projects: [{ id: 'repo', name: 'Repo', path: projectPath, codexArgs: [] }],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
  };
}

export class FakeCodexRunner implements CodexRunner {
  readonly sentMessages: string[] = [];
  private sessions = new Set<string>();

  async healthCheck(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async start(options: CodexRunOptions): Promise<void> {
    this.sessions.add(options.sessionId);
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    this.sentMessages.push(text);
  }

  async stop(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because `SessionManager` does not exist.

- [ ] **Step 3: Implement SessionManager**

`src/session/SessionManager.ts`:

```ts
import type { BotConfig, ChatContext, ChatType, SessionRecord } from '../domain/types.js';
import { parseIncomingText } from '../commands/CommandRouter.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { isAuthorizedMessage, resolveProject } from '../security/guards.js';

export interface IncomingBotText {
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export interface BotTextResult {
  reply: string;
}

export class SessionManager {
  constructor(
    private readonly config: BotConfig,
    private readonly store: FileStateStore,
    private readonly runner: CodexRunner,
  ) {}

  async handleText(input: IncomingBotText): Promise<BotTextResult> {
    if (!isAuthorizedMessage(this.config, input)) {
      return { reply: 'You are not allowed to control this bot.' };
    }

    const parsed = parseIncomingText(input.text);
    if (parsed.kind === 'message') {
      return this.sendToCurrentSession(input.chatId, parsed.text);
    }

    switch (parsed.name) {
      case 'projects':
        return { reply: this.config.projects.map((project) => `${project.id}: ${project.name}`).join('\n') };
      case 'new':
        return this.createSession(input, parsed.args[0]);
      case 'send':
        return this.sendToCurrentSession(input.chatId, parsed.args[0] ?? '');
      case 'status':
        return this.status(input.chatId);
      default:
        return { reply: `Unknown command: /${parsed.name}` };
    }
  }

  private async createSession(input: IncomingBotText, projectId?: string): Promise<BotTextResult> {
    const selectedProjectId = projectId ?? (await this.store.getChat(input.chatId))?.currentProjectId;
    if (!selectedProjectId) {
      return { reply: 'Choose a project with /projects and /new <project>.' };
    }
    const project = resolveProject(this.config, selectedProjectId);
    if (!project) {
      return { reply: `Unknown project: ${selectedProjectId}` };
    }

    const now = new Date().toISOString();
    const sessionId = createCodexSessionId();
    const session: SessionRecord = {
      id: sessionId,
      chatId: input.chatId,
      projectId: project.id,
      status: 'running',
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
      logPath: this.store.sessionLogPath(sessionId),
    };
    const chat: ChatContext = {
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: project.id,
      currentSessionId: sessionId,
    };

    await this.runner.start({
      sessionId,
      cwd: project.path,
      args: project.codexArgs,
      onOutput: (text) => void this.store.appendSessionLog(sessionId, text),
      onExit: (exitCode) => void this.markExited(session, exitCode),
    });
    await this.store.saveSession(session);
    await this.store.saveChat(chat);
    await this.store.appendEvent({ type: 'session.created', at: now, data: { sessionId, projectId: project.id, chatId: input.chatId } });

    return { reply: `Created session ${sessionId} for project ${project.id}.` };
  }

  private async sendToCurrentSession(chatId: string, text: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session. Run /projects and /new <project> first.' };
    }
    await this.runner.send(chat.currentSessionId, text);
    await this.store.appendEvent({ type: 'session.input', at: new Date().toISOString(), data: { sessionId: chat.currentSessionId } });
    return { reply: `Sent to Codex session ${chat.currentSessionId}.` };
  }

  private async status(chatId: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }
    const session = await this.store.getSession(chat.currentSessionId);
    return { reply: `Project: ${chat.currentProjectId}\nSession: ${chat.currentSessionId}\nStatus: ${session?.status ?? 'unknown'}` };
  }

  private async markExited(session: SessionRecord, exitCode: number | undefined): Promise<void> {
    await this.store.saveSession({
      ...session,
      status: 'exited',
      exitCode,
      updatedAt: new Date().toISOString(),
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts tests/helpers/fakes.ts
git commit -m "feat(session): 编排 Codex 会话流程"
```

## Task 10: Feishu Gateway and App Wiring

**Files:**
- Create: `src/feishu/FeishuGateway.ts`
- Create: `src/app/createApp.ts`
- Create: `src/index.ts`
- Create: `tests/app/createApp.test.ts`

- [ ] **Step 1: Write failing app wiring test**

`tests/app/createApp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/createApp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('createApp', () => {
  it('wires dependencies and exposes health', async () => {
    const root = await createTmpDir();
    const app = createApp({
      projectRoot: root,
      config: sampleConfig(root),
      store: new FileStateStore(root),
      codexRunner: new FakeCodexRunner(),
    });

    await expect(app.healthCheck()).resolves.toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/app/createApp.test.ts
```

Expected: FAIL because app wiring does not exist.

- [ ] **Step 3: Implement gateway interface, app factory, and entry point**

`src/feishu/FeishuGateway.ts`:

```ts
import * as lark from '@larksuiteoapi/node-sdk';
import type { ChatType } from '../domain/types.js';

export interface FeishuIncomingMessage {
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export interface FeishuGateway {
  start(onMessage: (message: FeishuIncomingMessage) => Promise<string>): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
}

export class LarkLongConnectionGateway implements FeishuGateway {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;

  constructor(appId: string, appSecret: string) {
    this.client = new lark.Client({ appId, appSecret });
    this.wsClient = new lark.WSClient({ appId, appSecret });
  }

  async start(onMessage: (message: FeishuIncomingMessage) => Promise<string>): Promise<void> {
    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: { message?: { chat_id?: string; chat_type?: string; content?: string }; sender?: { sender_id?: { open_id?: string } } }) => {
          const message = data.message;
          const sender = data.sender?.sender_id;
          if (!message?.chat_id || !message.content || !sender?.open_id) {
            return;
          }
          const content = JSON.parse(message.content) as { text?: string };
          const reply = await onMessage({
            chatId: message.chat_id,
            chatType: message.chat_type === 'group' ? 'group' : 'private',
            userId: sender.open_id,
            text: content.text ?? '',
          });
          await this.sendText(message.chat_id, reply);
        },
      }),
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }
}
```

`src/app/createApp.ts`:

```ts
import type { BotConfig } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import type { CodexRunner } from '../codex/CodexRunner.js';
import { SessionManager } from '../session/SessionManager.js';

export interface AppDependencies {
  projectRoot: string;
  config: BotConfig;
  store: FileStateStore;
  codexRunner: CodexRunner;
}

export function createApp(deps: AppDependencies): { sessionManager: SessionManager; healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }> } {
  return {
    sessionManager: new SessionManager(deps.config, deps.store, deps.codexRunner),
    healthCheck: () => deps.codexRunner.healthCheck(),
  };
}
```

`src/index.ts`:

```ts
import { cwd } from 'node:process';
import { loadConfig } from './config/loadConfig.js';
import { FileStateStore } from './state/FileStateStore.js';
import { PtyCodexRunner } from './codex/CodexRunner.js';
import { createApp } from './app/createApp.js';
import { LarkLongConnectionGateway } from './feishu/FeishuGateway.js';

async function main(): Promise<void> {
  const projectRoot = cwd();
  const config = await loadConfig(projectRoot);
  const store = new FileStateStore(projectRoot);
  const codexRunner = new PtyCodexRunner(config.codex);
  const app = createApp({ projectRoot, config, store, codexRunner });
  const health = await app.healthCheck();
  if (!health.ok) {
    console.error(health.reason);
  }
  const gateway = new LarkLongConnectionGateway(config.feishu.appId, config.feishu.appSecret);
  await gateway.start((message) => app.sessionManager.handleText(message).then((result) => result.reply));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run tests and build**

Run:

```bash
npm test -- tests/app/createApp.test.ts
npm run build
```

Expected: both commands pass. If the Feishu SDK type surface differs from the code above, adjust only `src/feishu/FeishuGateway.ts` to match installed SDK types while keeping the `FeishuGateway` interface unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/FeishuGateway.ts src/app/createApp.ts src/index.ts tests/app/createApp.test.ts
git commit -m "feat(app): 接入飞书长连接入口"
```

## Task 11: Complete Command Coverage

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Add failing tests for remaining commands**

Append to `tests/session/SessionManager.test.ts`:

```ts
it('supports /use, /status, and /tail', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

  await expect(manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo' }))
    .resolves.toEqual({ reply: 'Current project set to repo.' });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new' });

  const status = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });
  expect(status.reply).toContain('Project: repo');

  const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });
  expect(tail.reply).toContain('```text');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because `/use` and `/tail` are not implemented.

- [ ] **Step 3: Implement command cases**

Replace the `switch` in `src/session/SessionManager.ts` with:

```ts
    switch (parsed.name) {
      case 'help':
        return { reply: '/projects\n/use <project>\n/new [project]\n/send <text>\n/status\n/tail [n]\n/stop\n/sessions\n/approve <id>\n/reject <id>' };
      case 'projects':
        return { reply: this.config.projects.map((project) => `${project.id}: ${project.name}`).join('\n') };
      case 'use':
        return this.useProject(input, parsed.args[0]);
      case 'new':
        return this.createSession(input, parsed.args[0]);
      case 'send':
        return this.sendToCurrentSession(input.chatId, parsed.args[0] ?? '');
      case 'status':
        return this.status(input.chatId);
      case 'tail':
        return this.tail(input.chatId, parsed.args[0]);
      default:
        return { reply: `Unknown command: /${parsed.name}` };
    }
```

Add these private methods to the class:

```ts
  private async useProject(input: IncomingBotText, projectId?: string): Promise<BotTextResult> {
    if (!projectId || !resolveProject(this.config, projectId)) {
      return { reply: `Unknown project: ${projectId ?? ''}`.trim() };
    }
    const existing = await this.store.getChat(input.chatId);
    await this.store.saveChat({
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: projectId,
      currentSessionId: existing?.currentSessionId,
    });
    return { reply: `Current project set to ${projectId}.` };
  }

  private async tail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }
    const count = requestedCount ? Number.parseInt(requestedCount, 10) : 80;
    const lines = await this.store.tailSessionLog(chat.currentSessionId, Number.isFinite(count) && count > 0 ? count : 80);
    return { reply: `\`\`\`text\n${lines.join('\n')}\n\`\`\`` };
  }
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat(session): 补齐基础会话命令"
```

## Task 12: Final Verification and Manual Run Guide

**Files:**
- Create: `README.md`
- Create: `config.example.json`

- [ ] **Step 1: Replace README with run guide**

`README.md`:

```md
# code_bot

Feishu long-connection bot for controlling local Codex CLI sessions.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local config:

   ```bash
   mkdir -p .code-bot
   cp config.example.json .code-bot/config.json
   ```

3. Edit `.code-bot/config.json` with the Feishu app ID, app secret, allowed open IDs, allowed chat IDs, and project paths.

4. Start the bot:

   ```bash
   npm run dev
   ```

## First Commands

- `/projects`
- `/new <project>`
- `/status`
- `/tail 80`
```

`config.example.json`:

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "replace-with-secret"
  },
  "allowedUsers": ["ou_xxx"],
  "allowedChatIds": ["oc_xxx"],
  "projects": [
    {
      "id": "code_bot",
      "name": "code_bot",
      "path": "/absolute/path/to/code_bot",
      "codexArgs": []
    }
  ],
  "output": {
    "directMaxChars": 1800,
    "chunkSize": 1500
  },
  "codex": {
    "command": "codex",
    "defaultArgs": []
  }
}
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run build
```

Expected: all tests pass and TypeScript emits `dist/`.

- [ ] **Step 3: Commit**

```bash
git add README.md config.example.json
git commit -m "docs(readme): 添加本地运行说明"
```

- [ ] **Step 4: Manual acceptance checklist**

Run:

```bash
npm run dev
```

Expected local observations:

- If `codex` is missing, startup prints `Command not found: codex` while the bot process remains running.
- With valid Feishu credentials, the process establishes the long connection.
- In private chat or allowlisted group chat, `/projects` returns configured projects.
- `/new <project>` creates a session snapshot under `.code-bot/state/sessions/`.
- A normal text message is sent to the current Codex session.
- `/tail 80` returns recent local session log lines.
