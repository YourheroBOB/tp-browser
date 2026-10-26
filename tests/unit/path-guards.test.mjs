import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateLoopbackDebuggerWsUrl,
  safeDownloadEntryName,
  downloadPathInDir,
  safePath,
  writeFileNoFollow,
  acceptDomMark,
  nextDomMark,
} from '../../daemon/path-guards.js';

const PORT = 9773;

test('validateLoopbackDebuggerWsUrl accepts matching loopback debugger URL', () => {
  const u = `ws://127.0.0.1:${PORT}/devtools/browser/abc`;
  assert.equal(validateLoopbackDebuggerWsUrl(u, PORT), u);
});

test('validateLoopbackDebuggerWsUrl rejects userinfo host confusion', () => {
  const bad = `ws://127.0.0.1:${PORT}@example.invalid/cdp`;
  assert.throws(() => validateLoopbackDebuggerWsUrl(bad, PORT), /unexpected webSocketDebuggerUrl/);
});

test('validateLoopbackDebuggerWsUrl rejects wrong port', () => {
  assert.throws(
    () => validateLoopbackDebuggerWsUrl('ws://127.0.0.1:22/x', PORT),
    /unexpected webSocketDebuggerUrl/,
  );
});

test('safeDownloadEntryName and downloadPathInDir block traversal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-dl-'));
  try {
    assert.equal(safeDownloadEntryName('ok.txt'), 'ok.txt');
    assert.equal(downloadPathInDir(dir, 'ok.txt'), join(dir, 'ok.txt'));
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    assert.equal(downloadPathInDir(dir, uuid), join(dir, uuid));
    for (const bad of ['', '../../.ssh/id_rsa', '..', 'foo/../../etc/passwd', '/etc/passwd', '..\\secret.txt', 'a/../b', '\0x']) {
      assert.throws(() => safeDownloadEntryName(bad), /invalid download/);
      assert.throws(() => downloadPathInDir(dir, bad), /invalid download/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileNoFollow rejects leaf symlink and keeps target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-sym-'));
  const prev = process.umask(0o022);
  try {
    const target = join(dir, 'real.bin');
    writeFileSync(target, 'KEEP');
    const before = statSync(target);
    const leaf = join(dir, 'leaf.png');
    symlinkSync(target, leaf);
    assert.throws(() => writeFileNoFollow(leaf, Buffer.from('NEW'), { mode: 0o600 }), { name: 'BadPath' });
    assert.equal(readFileSync(target, 'utf8'), 'KEEP');
    assert.equal(statSync(target).mtimeMs, before.mtimeMs);
    const ordinary = join(dir, 'shot.bin');
    writeFileNoFollow(ordinary, Buffer.from('x'), { mode: 0o600 });
    assert.equal(statSync(ordinary).mode & 0o777, 0o600);
    const parentLink = join(dir, 'parent-link');
    symlinkSync(dir, parentLink);
    const nested = join(parentLink, 'via-parent.txt');
    writeFileNoFollow(nested, Buffer.from('ok'), { mode: 0o600 });
    assert.equal(readFileSync(join(dir, 'via-parent.txt'), 'utf8'), 'ok');
  } finally {
    process.umask(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safePath mustExist still resolves real files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-sp-'));
  try {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'x');
    assert.equal(safePath(f, { mustExist: true }), f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptDomMark requires exact daemon mark', () => {
  const expected = nextDomMark(1);
  assert.equal(expected, 'ego-1');
  assert.equal(acceptDomMark('ego-1', expected), true);
  assert.equal(acceptDomMark('ego-2', expected), false);
  assert.equal(acceptDomMark('ego-1"],input', expected), false);
  assert.equal(acceptDomMark('egoid-abc', expected), false);
});
