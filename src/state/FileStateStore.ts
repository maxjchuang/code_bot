import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
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
type WriteQueueName = 'state' | 'events' | 'sessionLogs';

const MAX_TAIL_SCAN_BYTES = 1_048_576;
const MAX_LOG_LINE_CHARS = 16_384;

function capLogLine(line: string): string {
  if (line.length <= MAX_LOG_LINE_CHARS) {
    return line;
  }
  return `[truncated ${line.length - MAX_LOG_LINE_CHARS} chars]${line.slice(-MAX_LOG_LINE_CHARS)}`;
}

async function readFileWindow(filePath: string, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const file = await open(filePath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < length) {
      const result = await file.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export class FileStateStore {
  private readonly writeChains: Record<WriteQueueName, Promise<unknown>> = {
    state: Promise.resolve(),
    events: Promise.resolve(),
    sessionLogs: Promise.resolve(),
  };
  private readonly writeContext = new AsyncLocalStorage<WriteQueueName>();
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
    return this.enqueue('state', async () => {
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
    const approvals = await this.listPendingApprovals();
    return approvals.filter((approval) => approval.chatId === chatId);
  }

  async listPendingApprovals(): Promise<ApprovalRecord[]> {
    await this.waitForPendingWrites('state');
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

    return approvals.filter((approval): approval is ApprovalRecord => Boolean(approval && approval.status === 'pending'));
  }

  async claimInboundMessage(input: ClaimInboundMessageInput): Promise<ClaimInboundMessageResult> {
    if (!input.messageId) {
      return { claimed: true, reason: 'missing_message_id' };
    }

    const messageId = input.messageId;
    const id = this.safeFileName(messageId);
    const filePath = join(this.baseDir, 'state/inbound-messages', `${id}.json`);
    return this.enqueue('state', async () => {
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
    await this.enqueue('events', async () => {
      const filePath = join(this.baseDir, 'events', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  async appendErrorLog(entry: BotErrorLogEntry): Promise<void> {
    const day = this.clock().toISOString().slice(0, 10);
    await this.enqueue('events', async () => {
      const filePath = join(this.baseDir, 'logs/errors', `${day}.jsonl`);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    });
  }

  async appendSessionLog(sessionId: string, text: string): Promise<void> {
    await this.enqueue('sessionLogs', async () => {
      const filePath = this.sessionLogPath(sessionId);
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, text, 'utf8');
    });
  }

  async tailSessionLog(sessionId: string, lineCount: number): Promise<string[]> {
    const normalizedLineCount = Math.floor(lineCount);
    if (!Number.isFinite(lineCount) || normalizedLineCount <= 0) {
      return [];
    }

    await this.waitForPendingWrites('sessionLogs');
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const isBoundedTail = size > MAX_TAIL_SCAN_BYTES;
      const start = isBoundedTail ? size - MAX_TAIL_SCAN_BYTES + 1 : 0;
      const readStart = isBoundedTail ? start - 1 : start;
      const bytesToRead = size - readStart;
      const buffer = await readFileWindow(filePath, readStart, bytesToRead);

      const previousByte = isBoundedTail && buffer.length > 0 ? buffer[0] : undefined;
      const contentStart = isBoundedTail ? 1 : 0;
      const content = buffer.subarray(contentStart).toString('utf8');
      const lines = content.split(/\r?\n/);
      if (isBoundedTail && previousByte !== 0x0a && lines.length > 1) {
        lines.shift();
      }
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.slice(-normalizedLineCount).map(capLogLine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async tailSessionLogBytes(sessionId: string, maxBytes: number): Promise<string> {
    const normalizedMaxBytes = Math.floor(maxBytes);
    if (!Number.isFinite(maxBytes) || normalizedMaxBytes <= 0) {
      return '';
    }

    await this.waitForPendingWrites('sessionLogs');
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const bytesToRead = Math.min(size, normalizedMaxBytes);
      const start = size - bytesToRead;
      const buffer = await readFileWindow(filePath, start, bytesToRead);
      return buffer.toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  async sessionLogSize(sessionId: string): Promise<number> {
    await this.waitForPendingWrites('sessionLogs');
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
    await this.waitForPendingWrites('sessionLogs');
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const isOldOffset = size - byteOffset > MAX_TAIL_SCAN_BYTES;
      const start = isOldOffset ? size - MAX_TAIL_SCAN_BYTES + 1 : byteOffset;
      const readStart = isOldOffset ? start - 1 : start;
      const bytesToRead = Math.max(0, size - readStart);
      const buffer = await readFileWindow(filePath, readStart, bytesToRead);
      const previousByte = isOldOffset && buffer.length > 0 ? buffer[0] : undefined;
      const contentStart = isOldOffset ? 1 : 0;
      const content = buffer.subarray(contentStart).toString('utf8');
      const lines = content.split(/\r?\n/);
      if (isOldOffset && previousByte !== 0x0a && lines.length > 1) {
        lines.shift();
      }
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.map(capLogLine);
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
    await this.waitForPendingWrites('state');
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
    await this.waitForPendingWrites('state');
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
    await this.enqueue('state', async () => this.writeJsonFile(filePath, value));
  }

  private enqueue<T>(queue: WriteQueueName, operation: () => Promise<T>): Promise<T> {
    const run = () => this.writeContext.run(queue, operation);
    const next = this.writeChains[queue].then(run, run);
    this.writeChains[queue] = next.catch(() => undefined);
    return next;
  }

  private async waitForPendingWrites(queue: WriteQueueName): Promise<void> {
    if (this.writeContext.getStore() === queue) {
      return;
    }
    await this.writeChains[queue];
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmpPath, filePath);
  }
}
