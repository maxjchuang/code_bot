import { readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

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

    const entries: CodexIndexEntry[] = [];
    for (const line of content.split('\n').filter(Boolean)) {
      const entry = parseJsonLine<{ id: string; thread_name?: string; updated_at: string }>(line);
      if (entry) {
        entries.push({ id: entry.id, threadName: entry.thread_name, updatedAt: entry.updated_at });
      }
    }
    return entries;
  }

  async discoverForProject(request: DiscoverRequest): Promise<DiscoverResult> {
    const startedAtMs = Date.parse(request.startedAt);
    if (Number.isNaN(startedAtMs)) {
      return { ok: false, reason: 'not-found' };
    }

    const files = await this.listSessionFiles(join(this.codexHome, 'sessions'));
    const candidates: string[] = [];
    const projectPath = normalizePath(request.projectPath);

    for (const filePath of files) {
      const id = this.extractId(filePath);
      if (!id) {
        continue;
      }

      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < startedAtMs) {
        continue;
      }

      const cwd = await this.readSessionCwd(filePath);
      if (cwd && normalizePath(cwd) === projectPath) {
        candidates.push(id);
      }
    }

    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length === 1) {
      return { ok: true, codexSessionId: uniqueCandidates[0] };
    }

    return { ok: false, reason: uniqueCandidates.length === 0 ? 'not-found' : 'ambiguous' };
  }

  private extractId(filePath: string): string | undefined {
    return filePath.match(CODEX_UUID_PATTERN)?.[0];
  }

  private async readSessionCwd(filePath: string): Promise<string | undefined> {
    const content = await readFile(filePath, 'utf8');
    for (const line of content.split('\n').filter(Boolean)) {
      const event = parseJsonLine<{ type?: string; payload?: { cwd?: unknown } }>(line);
      if (event?.type === 'session_meta' && typeof event.payload?.cwd === 'string') {
        return event.payload.cwd;
      }
    }
    return undefined;
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

function parseJsonLine<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

function normalizePath(filePath: string): string {
  const normalized = normalize(filePath);
  if (normalized !== sep && normalized.endsWith(sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}
