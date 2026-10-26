import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveCookieImportPath } from '../../tools/cookie-import-path.js';

test('missing sources do not fall back to /tmp', () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-ck-'));
  try {
    const r = resolveCookieImportPath({ env: {}, home, exists: existsSync });
    assert.equal(r.ok, false);
    assert.equal(r.path, null);
    assert.equal(r.candidates.some((c) => String(c.path).includes('/tmp/ego-cookies.json')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('home cookies.json is used when present', () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-ck-'));
  try {
    const dir = join(home, '.local', 'share', 'ego-linux');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'cookies.json');
    writeFileSync(f, '[]');
    const r = resolveCookieImportPath({ env: {}, home, exists: existsSync });
    assert.equal(r.ok, true);
    assert.equal(r.path, f);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
