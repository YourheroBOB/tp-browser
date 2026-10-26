import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateLoopbackDebuggerWsUrl,
  safeDownloadEntryName,
  downloadPathInDir,
  safePath,
  writeFileNoFollow,
  copyFileNoFollow,
  acceptDomMark,
  nextDomMark,
  DOM_MARK_RE,
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
    assert.equal(safeDownloadEntryName('report..final.pdf'), 'report..final.pdf');
    assert.equal(downloadPathInDir(dir, 'v1..2.txt'), join(dir, 'v1..2.txt'));
    assert.equal(safeDownloadEntryName('年度報告..pdf'), '年度報告..pdf');
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

test('writeFileNoFollow does not chmod an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-mode-'));
  try {
    const f = join(dir, 'shot.png');
    writeFileSync(f, 'old', { mode: 0o644 });
    chmodSync(f, 0o644);
    writeFileNoFollow(f, Buffer.from('new'), { mode: 0o600 });
    assert.equal(readFileSync(f, 'utf8'), 'new');
    assert.equal(statSync(f).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyFileNoFollow streams without following dest symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-cp-'));
  try {
    const src = join(dir, 'src.bin');
    const dest = join(dir, 'dest.bin');
    writeFileSync(src, 'hello-copy');
    copyFileNoFollow(src, dest, { mode: 0o600 });
    assert.equal(readFileSync(dest, 'utf8'), 'hello-copy');
    const keep = join(dir, 'keep.bin');
    writeFileSync(keep, 'KEEP');
    const leaf = join(dir, 'leaf.bin');
    symlinkSync(keep, leaf);
    assert.throws(() => copyFileNoFollow(src, leaf, { mode: 0o600 }), { name: 'BadPath' });
    assert.equal(readFileSync(keep, 'utf8'), 'KEEP');
  } finally {
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

test('safePath allows foo..bar names and rejects .. segments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-dotdot-'));
  try {
    const nested = join(dir, 'foo..bar');
    mkdirSync(nested);
    const file = join(nested, 'x.png');
    writeFileSync(file, 'z');
    assert.equal(safePath(file), file);
    assert.throws(() => safePath(`${dir}/../outside.png`), /path traversal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptDomMark requires exact daemon nonce', () => {
  const expected = nextDomMark();
  assert.match(expected, DOM_MARK_RE);
  assert.equal(acceptDomMark(expected, expected), true);
  assert.equal(acceptDomMark('ego-1', expected), false);
  assert.equal(acceptDomMark(`${expected}"],input`, expected), false);
  const other = nextDomMark();
  assert.notEqual(other, expected);
  assert.equal(acceptDomMark(other, expected), false);
});
