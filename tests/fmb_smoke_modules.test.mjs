// Offline smoke: import libraries, parse entry files, and check CLI version/help.
// No network, no real credentials, no daemon listen, no profile copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../daemon/store.js';
import { buildPlan } from '../fmb_feature2/cli.js';
import { DEFAULT_POLICY, applyReapPlan, classifySpace, planReap } from '../fmb_feature2/reaper.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const CHECK_JS = [
  'bin/tp-browser.js',
  'bin/ego-browser.js',
  'daemon/cdp.js',
  'daemon/ego-browserd.js',
  'daemon/inpage.agent.js',
  'daemon/keys.js',
  'daemon/page-ops.js',
  'daemon/store.js',
  'daemon/tp-browserd.js',
  'lib/sdk.js',
  'tools/profile-init.js',
  'fmb_feature2/reaper.js',
  'fmb_feature2/cli.js',
  'tests/serve.mjs',
];

const CHECK_SH = ['install.sh', 'scripts/tp-start.sh', 'scripts/tp-stop.sh'];

const IMPORT_LIBS = [
  ['daemon/store.js', 'Store'],
  ['daemon/cdp.js', null],
  ['daemon/keys.js', null],
  ['daemon/page-ops.js', null],
  ['lib/sdk.js', null],
  ['fmb_feature2/reaper.js', 'planReap'],
  ['fmb_feature2/cli.js', 'buildPlan'],
];

const CLI_BINS = ['bin/tp-browser.js', 'bin/ego-browser.js'];

function redact(text) {
  return String(text ?? '').replace(/[A-Za-z0-9+/_=-]{24,}/g, 'FAKE_VALUE_FOR_TEST');
}

function fakeEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    LANG: 'C',
    LC_ALL: 'C',
    ...extra,
  };
}

function runNode(args, { cwd, timeout = 5000, input = '', envExtra = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-smoke-'));
  try {
    return spawnSync(process.execPath, args, {
      cwd: cwd ?? home,
      encoding: 'utf8',
      input,
      timeout,
      killSignal: 'SIGKILL',
      env: fakeEnv(home, envExtra),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function importLib(rel) {
  const abs = join(repoRoot, rel);
  const code = [
    "import { pathToFileURL } from 'node:url';",
    'const mod = await import(pathToFileURL(process.env.FMB_SMOKE_ABS).href);',
    'const keys = Object.keys(mod);',
    "process.stdout.write('FMB_SMOKE_JSON:' + JSON.stringify({ ok: true, keys }));",
  ].join('\n');
  const r = runNode(['--input-type=module', '-e', code], {
    timeout: 5000,
    envExtra: { FMB_SMOKE_ABS: abs },
  });
  const blob = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.status, 0, redact(blob).slice(0, 500));
  const line = String(r.stdout ?? '').split('\n').find((item) => item.startsWith('FMB_SMOKE_JSON:'));
  assert.ok(line, redact(blob).slice(0, 500));
  return JSON.parse(line.slice('FMB_SMOKE_JSON:'.length));
}

function firstAccept(scriptRel, attempts, accept) {
  const tried = [];
  for (const args of attempts) {
    const r = runNode([join(repoRoot, scriptRel), ...args], { timeout: 4000 });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    tried.push({
      args,
      status: r.status,
      signal: r.signal ?? null,
      excerpt: redact(text).slice(0, 240),
    });
    if (r.signal) continue;
    if (accept(r.status, text)) return;
  }
  assert.fail(JSON.stringify(tried));
}

test('執行環境符合 package.json engines.node >= 22', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 22, process.versions.node);
});

test('package.json 進入點存在且沒有 runtime 相依', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'tp-browser');
  assert.equal(pkg.version, '0.3.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  for (const rel of Object.values(pkg.bin)) {
    assert.equal(existsSync(join(repoRoot, rel)), true, rel);
  }
});

for (const rel of CHECK_JS) {
  test(`node --check 可解析 ${rel}`, () => {
    const file = join(repoRoot, rel);
    assert.equal(existsSync(file), true, rel);
    const r = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: repoRoot,
    });
    assert.equal(r.status, 0, redact(r.stderr).slice(0, 400));
  });
}

for (const rel of CHECK_SH) {
  test(`sh -n 可解析 ${rel}`, () => {
    const r = spawnSync('sh', ['-n', join(repoRoot, rel)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0, String(r.stderr ?? '').slice(0, 400));
  });
}

test('inpage agent 含代理標記（不執行腳本）', () => {
  const text = readFileSync(join(repoRoot, 'daemon/inpage.agent.js'), 'utf8');
  assert.match(text, /__egoAgent/);
});

for (const [rel, expectExport] of IMPORT_LIBS) {
  test(`假 HOME 子程序可匯入 ${rel}`, () => {
    const body = importLib(rel);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.keys));
    if (expectExport) assert.ok(body.keys.includes(expectExport));
  });
}

test('Store 在暫存 ledger 上回應最小建立', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-smoke-store-'));
  try {
    const store = new Store(join(dir, 'ledger.json'));
    assert.deepEqual(store.list(), []);
    const space = store.create({ name: 'fmb-smoke' });
    assert.equal(space.id, 1);
    assert.equal(space.name, 'fmb-smoke');
    assert.equal(space.pages.p1.targetId, null);
    assert.equal(store.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reaper 對空 ledger 與假 target 不回收', () => {
  assert.equal(DEFAULT_POLICY.reapIdleWhenNoLiveTargets, false);
  const info = classifySpace(
    {
      id: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      pages: { p1: { targetId: null } },
    },
    {
      liveTargets: ['FAKE_TARGET_FOR_TEST'],
      now: Date.parse('2026-01-01T00:00:00.000Z'),
    },
  );
  assert.equal(info.kind, 'unbound');
  assert.equal(info.idle, false);

  const plan = planReap({
    spaces: [],
    liveTargetIds: ['FAKE_TARGET_FOR_TEST'],
    now: 0,
  });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.examined, 0);
  const applied = applyReapPlan(
    {
      deleteSpace() {
        throw new Error('unexpected delete');
      },
      removePage() {
        throw new Error('unexpected drop');
      },
    },
    plan,
  );
  assert.deepEqual(applied.closedSpaces, []);
  assert.deepEqual(applied.droppedPages, []);
});

test('reaper CLI 模組對空 live 集合回 no-live-targets', () => {
  const plan = buildPlan(JSON.stringify({ spaces: [], liveTargetIds: [] }));
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
});

test('reaper CLI 空 stdin 印出 usage 並以 2 結束', () => {
  const r = runNode([join(repoRoot, 'fmb_feature2/cli.js')], { input: '', timeout: 5000 });
  assert.equal(r.status, 2, redact(r.stderr).slice(0, 400));
  assert.match(r.stderr, /usage:/);
});

for (const rel of CLI_BINS) {
  test(`${rel} 離線回應 version`, () => {
    firstAccept(rel, [['version'], ['--version'], ['-v']], (status, text) => {
      return status === 0
        && /0\.3\.\d+/.test(text)
        && !/ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(text);
    });
  });

  test(`${rel} 離線回應 help`, () => {
    firstAccept(rel, [['--help'], ['-h'], ['help']], (status, text) => {
      return status === 0
        && /usage|用法|help|指令|命令|options|commands|subcommands/i.test(text)
        && !/ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(text);
    });
  });
}
