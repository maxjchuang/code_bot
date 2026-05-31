import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-bot-'));
}
