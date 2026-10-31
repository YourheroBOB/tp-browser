// RG-A4 unit: Store.findByTargetId exists and resolves space+label (capsule push depends on it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../daemon/store.js';

test('findByTargetId', () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-store-'));
  try {
    const s = new Store(join(d, 'spaces.json'));
    const sp = s.create({ name: 'x' });
    s.bindPage(sp.id, 'p1', 'T-1');
    s.addPage(sp.id, 'p2', 'T-2');
    assert.equal(typeof s.findByTargetId, 'function');
    assert.deepEqual(s.findByTargetId('T-2'), { space: s.get(sp.id), label: 'p2' });
    assert.equal(s.findByTargetId('nope'), null);
    assert.equal(s.findByTargetId(null), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
