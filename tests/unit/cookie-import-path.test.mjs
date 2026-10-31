import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCookieImportPath } from '../../tools/cookie-import-path.js';

const TMP_EGO = '/tmp/' + 'ego-cookies.json';

test('missing sources do not fall back to tmp ego-cookies', () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-ck-'));
  try {
    const r = resolveCookieImportPath({ env: {}, home, exists: existsSync });
    assert.equal(r.ok, false);
    assert.equal(r.path, null);
    assert.equal(r.candidates.some((c) => String(c.path).includes(TMP_EGO)), false);
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

test('actual cookies-import.ego.js has no tmp ego-cookies fallback', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../tools/cookies-import.ego.js'), 'utf8');
  assert.equal(src.includes(TMP_EGO), false);
  assert.match(src, /cookies\.json/);
  assert.match(src, /ego-cookies\.json/);
});
