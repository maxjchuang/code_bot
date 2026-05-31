import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ApprovalRecord, BotEvent, ChatContext, SessionRecord } from '../domain/types.js';

type Clock = () => Date;

export class FileStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();
  private activeWriteDepth = 0;
  private readonly baseDir: string;

  constructor(projectRoot: string, private readonly clock: Clock = () => new Date()) {
    this.baseDir = join(projectRoot, '.code-bot');
  }

  async saveChat(chat: ChatContext): Promise<void> {
    const id = this.safeFileName(chat.chatId);
    await this.writeJson(join(this.baseDir, 'state/chats', `${id}.json`), chat);
  }

  async getChat(chatId: string): Promise<ChatContext | undefined> {
    const id = this.safeFileName(chatId);
    return this.readJson<ChatContext>(join(this.baseDir, 'state/chats', `${id}.json`));
  }

  async saveSession(session: SessionRecord): Promise<void> {
    const id = this.safeFileName(session.id);
    await this.writeJson(join(this.baseDir, 'state/sessions', `${id}.json`), session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const id = this.safeFileName(sessionId);
    return this.readJson<SessionRecord>(join(this.baseDir, 'state/sessions', `${id}.json`));
  }

  async listSessionsByChat(chatId: string, limit = 10): Promise<SessionRecord[]> {
    await this.waitForPendingWrites();
    const sessionsDir = join(this.baseDir, 'state/sessions');
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const sessions = await Promise.all(
      files
        .filter((fileName) => fileName.endsWith('.json'))
        .map(async (fileName) => this.readJson<SessionRecord>(join(sessionsDir, fileName))),
    );

    return sessions
      .filter((session): session is SessionRecord => Boolean(session && session.chatId === chatId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async saveApproval(approval: ApprovalRecord): Promise<void> {
    const id = this.safeFileName(approval.id);
    await this.writeJson(join(this.baseDir, 'state/approvals', `${id}.json`), approval);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const id = this.safeFileName(approvalId);
    return this.readJson<ApprovalRecord>(join(this.baseDir, 'state/approvals', `${id}.json`));
  }

  async listPendingApprovalsByChat(chatId: string): Promise<ApprovalRecord[]> {
    await this.waitForPendingWrites();
    const approvalsDir = join(this.baseDir, 'state/approvals');
    let files: string[];
    try {
      files = await readdir(approvalsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const approvals = await Promise.all(
      files
        .filter((fileName) => fileName.endsWith('.json'))
        .map(async (fileName) => this.readJson<ApprovalRecord>(join(approvalsDir, fileName))),
    );

    return approvals.filter((approval): approval is ApprovalRecord => Boolean(approval && approval.chatId === chatId && approval.status === 'pending'));
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
    await this.waitForPendingWrites();
    try {
      const content = await readFile(this.sessionLogPath(sessionId), 'utf8');
      const lines = content.split(/\r?\n/);
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.slice(-lineCount);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  sessionLogPath(sessionId: string): string {
    const id = this.safeFileName(sessionId);
    return join(this.baseDir, 'logs/sessions', `${id}.log`);
  }

  private safeFileName(id: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(`Invalid state id: ${id}`);
    }
    return id;
  }

  private async readJson<T>(filePath: string): Promise<T | undefined> {
    await this.waitForPendingWrites();
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
    const run = async () => {
      this.activeWriteDepth += 1;
      try {
        return await operation();
      } finally {
        this.activeWriteDepth -= 1;
      }
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async waitForPendingWrites(): Promise<void> {
    if (this.activeWriteDepth > 0) {
      return;
    }
    await this.writeChain;
  }
}
