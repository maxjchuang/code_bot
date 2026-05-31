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
