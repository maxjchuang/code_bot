import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ApprovalRecord,
  BotErrorLogEntry,
  BotEvent,
  ChatContext,
  ClaimInboundMessageInput,
  ClaimInboundMessageResult,
  InboundMessageReceipt,
  SessionRecord,
} from '../domain/types.js';

type Clock = () => Date;

export class FileStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly writeContext = new AsyncLocalStorage<boolean>();
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

  async listChats(): Promise<ChatContext[]> {
    const chats = await this.readJsonDirectory<ChatContext>(join(this.baseDir, 'state/chats'));
    return chats.sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  async saveSession(session: SessionRecord): Promise<void> {
    const id = this.safeFileName(session.id);
    await this.writeJson(join(this.baseDir, 'state/sessions', `${id}.json`), session);
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const id = this.safeFileName(sessionId);
    return this.readJson<SessionRecord>(join(this.baseDir, 'state/sessions', `${id}.json`));
  }

  async listSessions(): Promise<SessionRecord[]> {
    const sessions = await this.readJsonDirectory<SessionRecord>(join(this.baseDir, 'state/sessions'));
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateSession(sessionId: string, updater: (current: SessionRecord) => SessionRecord): Promise<SessionRecord | undefined> {
    const id = this.safeFileName(sessionId);
    const filePath = join(this.baseDir, 'state/sessions', `${id}.json`);
    return this.enqueue(async () => {
      const current = await this.readJson<SessionRecord>(filePath);
      if (!current) {
        return undefined;
      }
      const next = updater(current);
      await this.writeJsonFile(filePath, next);
      return next;
    });
  }

  async listSessionsByChat(chatId: string, limit = 10): Promise<SessionRecord[]> {
    const sessions = await this.listSessions();
    return sessions
      .filter((session) => session.chatId === chatId)
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

  async claimInboundMessage(input: ClaimInboundMessageInput): Promise<ClaimInboundMessageResult> {
    if (!input.messageId) {
      return { claimed: true, reason: 'missing_message_id' };
    }

    const messageId = input.messageId;
    const id = this.safeFileName(messageId);
    const filePath = join(this.baseDir, 'state/inbound-messages', `${id}.json`);
    return this.enqueue(async () => {
      const current = await this.readJson<InboundMessageReceipt>(filePath);
      if (current) {
        const duplicate: InboundMessageReceipt = {
          ...current,
          lastDuplicateAt: this.clock().toISOString(),
          duplicateCount: current.duplicateCount + 1,
        };
        await this.writeJsonFile(filePath, duplicate);
        return { claimed: false, receipt: duplicate };
      }

      const receipt: InboundMessageReceipt = {
        messageId,
        chatId: input.chatId,
        chatType: input.chatType,
        userId: input.userId,
        textPreview: input.text.length <= 200 ? input.text : `${input.text.slice(0, 197)}...`,
        firstReceivedAt: this.clock().toISOString(),
        duplicateCount: 0,
        status: 'claimed',
      };
      await this.writeJsonFile(filePath, receipt);
      return { claimed: true, receipt };
    });
  }

  async appendEvent(event: BotEvent): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    await this.enqueue(async () => {
      const filePath = join(this.baseDir, 'events', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  async appendErrorLog(entry: BotErrorLogEntry): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    await this.enqueue(async () => {
      const filePath = join(this.baseDir, 'logs/errors', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
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

  async sessionLogSize(sessionId: string): Promise<number> {
    await this.waitForPendingWrites();
    try {
      return (await stat(this.sessionLogPath(sessionId))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  async sessionLogLinesFrom(sessionId: string, byteOffset: number): Promise<string[]> {
    await this.waitForPendingWrites();
    try {
      const content = await readFile(this.sessionLogPath(sessionId));
      const lines = content.subarray(byteOffset).toString('utf8').split(/\r?\n/);
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines;
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

  private async readJsonDirectory<T>(directoryPath: string): Promise<T[]> {
    await this.waitForPendingWrites();
    let files: string[];
    try {
      files = await readdir(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const records: Array<T | undefined> = await Promise.all(
      files.filter((fileName) => fileName.endsWith('.json')).map(async (fileName) => this.readJson<T>(join(directoryPath, fileName))),
    );
    return records.filter((record): record is T => Boolean(record));
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await this.enqueue(async () => this.writeJsonFile(filePath, value));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.writeContext.run(true, operation);
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async waitForPendingWrites(): Promise<void> {
    if (this.writeContext.getStore() === true) {
      return;
    }
    await this.writeChain;
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmpPath, filePath);
  }
}
