import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';

test('a rejected FileStore mutation does not persist partial state or poison later writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-file-store-recovery-'));
  const store = new FileStore(path.join(dir, 'store.json'));

  await store.mutate((state) => {
    state.metadata ||= {};
    state.metadata.marker = 'good';
  });

  await assert.rejects(
    store.mutate((state) => {
      state.metadata.marker = 'bad';
      throw new Error('expected validation failure');
    }),
    /expected validation failure/,
  );

  assert.equal((await store.read()).metadata.marker, 'good');

  await store.mutate((state) => {
    state.metadata.marker = 'recovered';
  });

  assert.equal((await store.read()).metadata.marker, 'recovered');
});
