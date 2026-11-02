// Regression: a ledger whose root was null, an array, or a scalar was stored
// as this.data and every later call threw. Load now keeps the default ledger,
// copies the original bytes to `<file>.corrupt-<ts>` (not a `.tmp` name), and
// leaves that backup intact when a later persist rewrites the live file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-root-'));
  return { dir, file: join(dir, 'ledger.json') };
}

function corruptNames(dir) {
  return readdirSync(dir).filter((name) => name.startsWith('ledger.json.corrupt-'));
}

test('a valid object ledger is not backed up or rewritten on load', () => {
  const { dir, file } = tempLedger();
  try {
    const body = JSON.stringify({ nextSpaceId: 1, labelSeq: {}, spaces: {} });
    writeFileSync(file, body);
    const store = new Store(file);
    assert.equal(store.data.nextSpaceId, 1);
    assert.deepEqual(store.data.spaces, {});
    assert.deepEqual(corruptNames(dir), []);
    assert.equal(readFileSync(file, 'utf8'), body);
    store.create({ name: 'ok' });
    assert.deepEqual(corruptNames(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-object roots start fresh and the corrupt backup survives the next persist', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    for (const raw of ['[]', 'null', '42', 'true', '"x"']) {
      const { dir, file } = tempLedger();
      try {
        writeFileSync(file, raw);
        const store = new Store(file);
        assert.equal(store.data.nextSpaceId, 1);
        assert.deepEqual(store.data.spaces, {});
        assert.deepEqual(store.data.labelSeq, {});

        const names = corruptNames(dir);
        assert.equal(names.length, 1, raw);
        const backupName = names[0];
        assert.match(backupName, /^ledger\.json\.corrupt-\d+$/);
        assert.equal(backupName.endsWith('.tmp'), false);
        const backupPath = join(dir, backupName);
        assert.equal(readFileSync(backupPath, 'utf8'), raw);
        assert.equal(readFileSync(file, 'utf8'), raw);

        const created = store.create({ name: 'recovered' });
        assert.equal(created.id, 1);
        assert.equal(readFileSync(backupPath, 'utf8'), raw);
        assert.equal(corruptNames(dir).length, 1);
        assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
        const live = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(live.spaces['1'].name, 'recovered');
        assert.notEqual(readFileSync(file, 'utf8'), raw);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    console.error = orig;
  }
});
