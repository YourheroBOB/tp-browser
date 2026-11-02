// Offline import smoke for tp-browser.
// No network, no real credentials, temp directories only.
// Run: node --test tests/fmb_smoke_imports.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../daemon/store.js';
import { applyReapPlan, classifySpace, DEFAULT_POLICY, planReap } from '../fmb_feature2/reaper.js';
import { buildPlan } from '../fmb_feature2/cli.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);

const SYNTAX_FILES = [
  'bin/ego-browser.js',
  'bin/tp-browser.js',
  'daemon/cdp.js',
  'daemon/ego-browserd.js',
  'daemon/inpage.agent.js',
  'daemon/keys.js',
  'daemon/page-ops.js',
  'daemon/store.js',
  'daemon/tp-browserd.js',
  'lib/sdk.js',
  'tools/profile-init.js',
  'fmb_feature2/cli.js',
  'fmb_feature2/reaper.js',
  'tests/serve.mjs',
];

const LIBRARY_IMPORTS = [
  'daemon/keys.js',
  'daemon/cdp.js',
  'daemon/page-ops.js',
  'lib/sdk.js',
];

function offlineEnv(home) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_CACHE_HOME: join(home, 'xdg-cache'),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    LANG: 'C',
    LC_ALL: 'C',
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'tp-fmb-smoke-'));
  mkdirSync(join(home, 'xdg-config'), { recursive: true });
  mkdirSync(join(home, 'xdg-data'), { recursive: true });
  mkdirSync(join(home, 'xdg-cache'), { recursive: true });
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function formatRun(r) {
  const err = r && r.error ? r.error.message : '';
  return [
    `status=${r && r.status}`,
    `signal=${r && r.signal}`,
    err ? `error=${err}` : '',
    `stdout=${JSON.stringify(r && r.stdout || '').slice(0, 400)}`,
    `stderr=${JSON.stringify(r && r.stderr || '').slice(0, 400)}`,
  ].filter(Boolean).join(' ');
}

function assertNoHostHome(text) {
  for (const key of ['HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value && value.length > 3) {
      assert.equal(String(text).includes(value), false, `${key} appeared in smoke output`);
    }
  }
}

function importScript(href) {
  return `
const mod = await import(${JSON.stringify(href)});
const keys = Object.keys(mod);
const types = {};
for (const k of keys) types[k] = typeof mod[k];
console.log('FMB_SMOKE_JSON ' + JSON.stringify({ keys, types }));
`;
}

function parseMarker(stdout) {
  const line = String(stdout || '')
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('FMB_SMOKE_JSON '));
  assert.ok(line, `missing smoke marker: ${stdout}`);
  return JSON.parse(line.slice('FMB_SMOKE_JSON '.length));
}

describe('fmb smoke imports', { concurrency: 1 }, () => {
  for (const rel of SYNTAX_FILES) {
    test(`node --check ${rel}`, { timeout: 15000 }, () => {
      const abs = join(repoRoot, rel);
      assert.equal(existsSync(abs), true, abs);
      const r = spawnSync(process.execPath, ['--check', abs], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(r.status, 0, formatRun(r));
    });
  }

  test('package.json bin entry points exist', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'tp-browser');
    assert.equal(pkg.type, 'module');
    assert.match(pkg.version, /^0\.3\.\d+$/);
    assert.equal(pkg.bin['tp-browser'], 'bin/tp-browser.js');
    assert.equal(pkg.bin['ego-browser'], 'bin/ego-browser.js');
    assert.equal(pkg.bin['tp-browserd'], 'daemon/tp-browserd.js');
    assert.equal(pkg.bin['ego-browserd'], 'daemon/ego-browserd.js');
    for (const rel of Object.values(pkg.bin)) {
      assert.equal(existsSync(join(repoRoot, rel)), true, rel);
    }
  });

  for (const rel of LIBRARY_IMPORTS) {
    test(`import ${rel} under a fake home`, { timeout: 15000 }, () => {
      withTempHome((home) => {
        const href = pathToFileURL(join(repoRoot, rel)).href;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', importScript(href)], {
          cwd: home,
          env: offlineEnv(home),
          encoding: 'utf8',
          timeout: 8000,
          killSignal: 'SIGKILL',
          input: '',
        });
        assert.equal(r.status, 0, formatRun(r));
        assert.equal(r.signal, null, formatRun(r));
        const info = parseMarker(r.stdout);
        assert.ok(Array.isArray(info.keys));
        assertNoHostHome(`${r.stdout || ''}\n${r.stderr || ''}`);
      });
    });
  }

  test('import daemon/inpage.agent.js or a missing browser global', { timeout: 15000 }, () => {
    withTempHome((home) => {
      const href = pathToFileURL(join(repoRoot, 'daemon/inpage.agent.js')).href;
      const script = `
try {
  const mod = await import(${JSON.stringify(href)});
  const keys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
  console.log('FMB_SMOKE_JSON ' + JSON.stringify({ ok: true, keys }));
} catch (err) {
  const name = err && err.name ? String(err.name) : 'Error';
  const message = err && err.message ? String(err.message).slice(0, 180) : '';
  console.log('FMB_SMOKE_JSON ' + JSON.stringify({ ok: false, name, message }));
}
`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: home,
        env: offlineEnv(home),
        encoding: 'utf8',
        timeout: 8000,
        killSignal: 'SIGKILL',
        input: '',
      });
      assert.equal(r.status, 0, formatRun(r));
      const info = parseMarker(r.stdout);
      if (info.ok !== true) {
        assert.match(info.name, /^(ReferenceError|TypeError)$/);
      }
      assertNoHostHome(`${r.stdout || ''}\n${r.stderr || ''}`);
    });
  });

  test('Store accepts a minimal offline ledger', () => {
    withTempHome((home) => {
      const file = join(home, 'ledger.json');
      const store = new Store(file);
      assert.deepEqual(store.list(), []);
      const space = store.create({ name: 'smoke' });
      assert.equal(space.id, 1);
      assert.equal(space.name, 'smoke');
      assert.equal(space.profileId, 'agent');
      assert.equal(space.pages.p1.targetId, null);
      assert.equal(store.list().length, 1);
      assert.equal(existsSync(file), true);
    });
  });

  test('reaper and cli entry accept minimal offline input', () => {
    assert.equal(typeof DEFAULT_POLICY.idleSpaceMs, 'number');
    assert.equal(typeof DEFAULT_POLICY.reapIdleWhenNoLiveTargets, 'boolean');
    const plan = planReap({ spaces: [], liveTargetIds: [] });
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
    const viaCli = buildPlan('{"spaces":[],"liveTargetIds":[]}');
    assert.equal(viaCli.reason, 'no-live-targets');
    assert.deepEqual(viaCli.closeSpaces, []);
    const classified = classifySpace({ id: 1, pages: {} }, { liveTargets: [], now: 0 });
    assert.equal(classified.kind, 'empty');
    assert.equal(classified.entries.length, 0);
    const applied = applyReapPlan({
      deleteSpace() {},
      removePage() {},
    }, plan);
    assert.deepEqual(applied.closedSpaces, []);
    assert.deepEqual(applied.droppedPages, []);
  });
});
