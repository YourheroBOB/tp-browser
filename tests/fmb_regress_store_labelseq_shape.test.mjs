// 回歸：labelSeq 為 null／陣列／純量時，create() 會拋 TypeError 或把陣列寫成畸形序號。
// 載入後必須改成一般物件，且既有 spaces 不可被清掉。
// 「整鍵缺少 labelSeq」已有別的測試，這裡不重覆。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

const badShapes = [null, ['p1', 'p2'], 5, true, 'nope'];

for (const bad of badShapes) {
  test(`labelSeq ${JSON.stringify(bad)} is replaced with a plain object before create`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-seqshape-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'ledger.json');
    writeFileSync(file, JSON.stringify({
      nextSpaceId: 5,
      labelSeq: bad,
      spaces: {
        4: {
          id: 4,
          name: 'old',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          pages: { p1: { targetId: 'T-old', openedBy: 'agent', title: '', url: '' } },
          activeTargetId: 'T-old',
        },
      },
    }));
    const store = new Store(file);
    const created = store.create({ name: 'fresh' });
    assert.equal(created.id, 5);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Array.isArray(raw.labelSeq), false);
    assert.equal(raw.labelSeq === null, false);
    assert.equal(typeof raw.labelSeq, 'object');
    assert.equal(raw.labelSeq['5'], 1);
    assert.equal(raw.spaces['4'].name, 'old');
    assert.equal(raw.spaces['4'].pages.p1.targetId, 'T-old');
    assert.equal(raw.spaces['5'].name, 'fresh');
    assert.equal(raw.nextSpaceId, 6);
  });
}
