// 回歸：ledger 根節點是合法 JSON 但不是物件（陣列、null、純量）時，
// 不可把該值塞進 this.data，也不可在降級成空 ledger 前把原檔直接蓋掉。
// 原檔要原樣複製成「不是 .tmp」的 .corrupt-<timestamp> 備份，之後 persist 也不得刪掉備份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

const roots = ['[]', 'null', '42', '"nope"', 'true'];

for (const rawBody of roots) {
  test(`illegal ledger root ${rawBody} is backed up and replaced only after a later persist`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-root-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'ledger.json');
    writeFileSync(file, rawBody);

    const origError = console.error;
    console.error = () => {};
    let store;
    try {
      store = new Store(file);
    } finally {
      console.error = origError;
    }

    assert.equal(readFileSync(file, 'utf8'), rawBody);
    assert.deepEqual(store.list(), []);
    assert.equal(store.data.nextSpaceId, 1);
    assert.deepEqual(store.data.labelSeq, {});
    assert.deepEqual(store.data.spaces, {});

    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /\.corrupt-\d+$/);
    assert.equal(backups[0].endsWith('.tmp'), false);
    assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), rawBody);

    const created = store.create({ name: 'fresh' });
    assert.equal(created.id, 1);
    assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), rawBody);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces['1'].name, 'fresh');
  });
}

test('a well-formed ledger does not get a corrupt backup', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-rootok-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  writeFileSync(file, JSON.stringify({ nextSpaceId: 2, labelSeq: {}, spaces: {} }));
  const store = new Store(file);
  assert.equal(store.data.nextSpaceId, 2);
  assert.equal(readdirSync(dir).some((name) => name.includes('.corrupt-')), false);
});
