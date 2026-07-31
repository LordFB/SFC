import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectRealtimeKeys } from '../realtime-build.js';

test('collects live realtime key literals without treating documentation snippets as live values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-realtime-build-'));
  try {
    fs.writeFileSync(path.join(directory, 'Example.sfc'), `
      <script lang="ts">
      const key = 'testing/benchmark/direct';
      const snippet = \`realtimeValue('testing/showcase/not-live', 0)\`;
      export default class extends HTMLElement {
        count = realtimeValue('testing/showcase/count', 0);
      }
      </script>
    `);
    assert.deepEqual(collectRealtimeKeys(directory), [
      'testing/benchmark/direct',
      'testing/showcase/count',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
