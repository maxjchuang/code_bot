import type { TerminalSnapshotConfig } from '../domain/types.js';
import { TerminalScreenBuffer, type TerminalSnapshot } from './TerminalScreenBuffer.js';

export class CodexTerminalObserver {
  private readonly buffers = new Map<string, TerminalScreenBuffer>();
  private readonly finalSnapshots = new Map<string, TerminalSnapshot>();

  constructor(private readonly config: TerminalSnapshotConfig) {}

  write(sessionId: string, chunk: string): void {
    const buffer = this.requireBuffer(sessionId);
    buffer.write(chunk);
    this.finalSnapshots.delete(sessionId);
  }

  snapshot(sessionId: string): TerminalSnapshot | undefined {
    const live = this.buffers.get(sessionId);
    if (live) {
      return live.snapshot('live');
    }
    return this.finalSnapshots.get(sessionId);
  }

  end(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) {
      return;
    }
    this.finalSnapshots.set(sessionId, buffer.snapshot('live', ['Session has exited.']));
    this.buffers.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.finalSnapshots.delete(sessionId);
  }

  private requireBuffer(sessionId: string): TerminalScreenBuffer {
    const existing = this.buffers.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new TerminalScreenBuffer(this.config);
    this.buffers.set(sessionId, created);
    return created;
  }
}
