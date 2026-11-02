// 離線冒煙：只匯入純模組，並用暫存目錄餵最小輸入。
// 不連外網、不讀真實資料目錄、不啟動 daemon 或瀏覽器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../daemon/store.js';
import { DEFAULT_POLICY, planReap, applyReapPlan } from '../fmb_feature2/reaper.js';
import { buildPlan } from '../fmb_feature2/cli.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IMPORTS = [
  'daemon/keys.js',
  'daemon/cdp.js',
  'daemon/page-ops.js',
  'lib/sdk.js',
];

const EXPORTS = {
  'daemon/keys.js': { parseChord: 'function', isModifier: 'function' },
  'daemon/cdp.js': { Cdp: 'function' },
};

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'fmb-smoke-home-'));
  const data = path.join(home, '.local', 'share', 'ego-linux');
  mkdirSync(path.join(data, 'logs'), { recursive: true });
  mkdirSync(path.join(data, 'profile-agent'), { recursive: true });
  mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const fileOpts = { encoding: 'utf8', mode: 0o600 };
  writeFileSync(path.join(data, 'token'), 'FAKE_VALUE_FOR_TEST\n', fileOpts);
  writeFileSync(path.join(data, 'daemon.json'), '{"port":1,"chromePort":1}\n', fileOpts);
  return home;
}

function envFor(home) {
  const temp = path.join(home, 'tmp');
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_NO_WARNINGS: '1',
    USER: 'fmb-smoke',
    LOGNAME: 'fmb-smoke',
    USERNAME: 'fmb-smoke',
  };
}

function importModule(rel, home) {
  const url = pathToFileURL(path.join(repoRoot, rel)).href;
  const script = [
    `const mod = await import(${JSON.stringify(url)});`,
    'const types = {};',
    'for (const key of Object.keys(mod)) types[key] = typeof mod[key];',
    "process.stdout.write(String.fromCharCode(10) + 'FMB_SMOKE_JSON=' + JSON.stringify({ keys: Object.keys(types), types }) + String.fromCharCode(10));",
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
    cwd: home,
    env: envFor(home),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
}

function parseSmoke(stdout) {
  const marker = String(stdout ?? '')
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.startsWith('FMB_SMOKE_JSON='));
  assert.ok(marker, `missing marker\n${String(stdout ?? '').slice(0, 500)}`);
  return JSON.parse(marker.slice('FMB_SMOKE_JSON='.length));
}

test('Store boots from an empty temp ledger', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fmb-smoke-store-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const store = new Store(file);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(1), null);
    const space = store.create({ name: 'fmb-smoke' });
    assert.equal(space.name, 'fmb-smoke');
    assert.equal(space.pages.p1.targetId, null);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(space.id).name, 'fmb-smoke');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces['1'].name, 'fmb-smoke');
    assert.equal(saved.nextSpaceId, 2);
    assert.equal(saved.spaces['1'].pages.p1.targetId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reaper accepts a minimal offline plan and an empty apply', () => {
  assert.equal(typeof DEFAULT_POLICY.idleSpaceMs, 'number');
  assert.ok(DEFAULT_POLICY.idleSpaceMs > 0);
  assert.equal(DEFAULT_POLICY.reapIdleWhenNoLiveTargets, false);

  const plan = planReap({
    spaces: [],
    liveTargetIds: ['FAKE_TARGET'],
    now: 1700000000000,
  });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.examined, 0);

  const viaCli = buildPlan('{"spaces":[],"liveTargetIds":["FAKE_TARGET"],"now":1700000000000}');
  assert.deepEqual(viaCli.closeSpaces, []);
  assert.equal(viaCli.stats.examined, 0);

  const applied = applyReapPlan({}, { closeSpaces: [], dropPages: [] });
  assert.deepEqual(applied, { closedSpaces: [], droppedPages: [] });
});

for (const rel of IMPORTS) {
  test(`imports ${rel} offline in a throwaway home`, () => {
    const home = makeHome();
    try {
      const result = importModule(rel, home);
      assert.equal(result.signal, null, String(result.signal));
      assert.equal(
        result.status,
        0,
        `${rel}\n${result.error?.message ?? ''}\n${String(result.stderr ?? '').slice(0, 800)}`,
      );
      const payload = parseSmoke(result.stdout);
      assert.ok(Array.isArray(payload.keys));
      const expected = EXPORTS[rel];
      if (expected) {
        for (const [name, type] of Object.entries(expected)) {
          assert.equal(payload.types[name], type, `${rel} export ${name}`);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
