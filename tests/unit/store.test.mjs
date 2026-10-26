import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, persistJsonAtomic } from '../../daemon/store.js';

test('Store create roundtrip', () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-store-'));
  try {
    const s = new Store(join(d, 'spaces.json'));
    const sp = s.create({ name: 't' });
    assert.equal(sp.name, 't');
    const s2 = new Store(join(d, 'spaces.json'));
    assert.equal(s2.get(sp.id).name, 't');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('persistJsonAtomic writes with 0600 mode', () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-store-'));
  const prev = process.umask(0o022);
  try {
    const f = join(d, 'spaces.json');
    persistJsonAtomic(f, '{"ok":true}');
    assert.equal(readFileSync(f, 'utf8'), '{"ok":true}');
    assert.equal(statSync(f).mode & 0o777, 0o600);
  } finally {
    process.umask(prev);
    rmSync(d, { recursive: true, force: true });
  }
});

test('persistJsonAtomic falls back to direct write when rename fails', () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-store-'));
  try {
    const f = join(d, 'spaces.json');
    writeFileSync(f, '{"old":1}', { mode: 0o600 });
    const result = persistJsonAtomic(f, '{"new":2}', {
      rename: () => { throw new Error('rename failed in test'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.fallback, true);
    assert.equal(readFileSync(f, 'utf8'), '{"new":2}');
    assert.equal(existsSync(`${f}.${process.pid}.tmp`), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('persistJsonAtomic throws when rename and fallback write both fail', () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-store-'));
  try {
    const f = join(d, 'spaces.json');
    const oldBody = '{"old":1}';
    writeFileSync(f, oldBody, { mode: 0o600 });
    assert.throws(() => persistJsonAtomic(f, '{"new":2}', {
      writeFile: (p, body, opts) => {
        if (p === f) throw new Error('direct write failed');
        writeFileSync(p, body, opts);
      },
      rename: () => { throw new Error('rename failed in test'); },
    }), /store persist failed/);
    assert.equal(readFileSync(f, 'utf8'), oldBody);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
