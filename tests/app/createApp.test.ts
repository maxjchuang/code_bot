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
