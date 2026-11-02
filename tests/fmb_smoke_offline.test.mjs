// Offline smoke: import libraries and exercise help / version / minimal input.
// No real HOME, no 9772/9774, no Chrome, no external services.
// Daemon, in-page agent, and profile-init are syntax-checked only so listen()
// or a profile copy cannot run.
// Every first-party .js/.mjs is also parse-checked; symlinks are skipped.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../daemon/store.js';
import { buildPlan } from '../fmb_feature2/cli.js';
import { applyReapPlan, classifySpace, planReap } from '../fmb_feature2/reaper.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'fmb-smoke-home-'));
const dataDir = join(home, '.local', 'share', 'ego-linux');
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
let seq = 0;

mkdirSync(join(home, 'tmp'), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(home, '.config'), { recursive: true });
mkdirSync(join(home, '.cache'), { recursive: true });
chmodSync(dataDir, 0o700);
writeFileSync(join(dataDir, 'token'), 'FAKE_VALUE_FOR_TEST\n', { mode: 0o600 });
chmodSync(join(dataDir, 'token'), 0o600);
writeFileSync(join(dataDir, 'daemon.json'), '{"port":59999,"chromePort":59999}\n', { mode: 0o600 });
chmodSync(join(dataDir, 'daemon.json'), 0o600);
process.env.HOME = home;
process.env.USERPROFILE = home;

const CHECK = [
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
  'fmb_feature2/cli.js',
  'fmb_feature2/reaper.js',
];

// README 寫的本機測試頁伺服器是 tests/serve.mjs；快照另有一筆未帶目錄的 serve.mjs。
// 只對實際存在的那一個做語法檢查。兩邊都不在時不把整組語法檢查判失敗：
// 這支冒煙不能啟動該伺服器，缺檔也不代表其餘模組無法匯入。
function localServerRel() {
  for (const rel of ['tests/serve.mjs', 'serve.mjs']) {
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
}

const IMPORTS = [
  'daemon/store.js',
  'daemon/keys.js',
  'daemon/cdp.js',
  'daemon/page-ops.js',
  'lib/sdk.js',
  'fmb_feature2/reaper.js',
  'fmb_feature2/cli.js',
];

const REQUIRED = {
  'daemon/store.js': ['Store'],
  'fmb_feature2/reaper.js': [
    'DEFAULT_POLICY',
    'toTargetSet',
    'pageEntries',
    'classifySpace',
    'planReap',
    'applyReapPlan',
  ],
  'fmb_feature2/cli.js': ['buildPlan'],
};

function childEnv() {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    LANG: 'C',
    LC_ALL: 'C',
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
}

function detail(result) {
  return [
    `status=${result.status} signal=${result.signal ?? ''} code=${result.error?.code ?? ''}`,
    String(result.stdout ?? '').slice(0, 400),
    String(result.stderr ?? '').slice(0, 400),
  ].join('\n');
}

function run(args, { timeout = 3000, input = '' } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    input,
    env: childEnv(),
  });
}

function spawnImport(absPath) {
  const importer = join(home, `imp-${++seq}.mjs`);
  const href = pathToFileURL(absPath).href;
  writeFileSync(importer, [
    `const mod = await import(${JSON.stringify(href)});`,
    "if (mod === null || typeof mod !== 'object') process.exit(2);",
    'console.log(JSON.stringify(Object.keys(mod)));',
    '',
  ].join('\n'));
  try {
    return spawnSync(process.execPath, [importer], {
      cwd: root,
      encoding: 'utf8',
      timeout: 4000,
      killSignal: 'SIGKILL',
      input: '',
      env: childEnv(),
    });
  } finally {
    rmSync(importer, { force: true });
  }
}

function indexOfQuoted(haystack, arg) {
  const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(['"])${escaped}\\1`).exec(haystack);
  return found ? found.index : -1;
}

function pickSafeArg(src, args) {
  const serverAt = src.search(/\.listen\s*\(|\bcreateServer\s*\(/);
  const region = serverAt === -1 ? src : src.slice(0, serverAt);
  for (const arg of args) {
    const at = indexOfQuoted(region, arg);
    if (at < 0) continue;
    if (serverAt === -1) return arg;
    const tail = src.slice(at, at + 1200);
    if (/process\.exit\s*\(/.test(tail)) return arg;
  }
  return null;
}

function minSpace() {
  return {
    id: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
  };
}

function listSourceFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      listSourceFiles(full, acc);
      continue;
    }
    if (st.isFile() && (name.endsWith('.js') || name.endsWith('.mjs'))) acc.push(full);
  }
  return acc;
}

describe('tp-browser offline smoke', { concurrency: false }, () => {
  test.after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('package.json points at real bins', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'tp-browser');
    assert.equal(pkg.type, 'module');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    for (const rel of Object.values(pkg.bin)) {
      assert.equal(typeof rel, 'string');
      assert.ok(existsSync(join(root, rel)), rel);
    }
  });

  test('every local module passes node --check', () => {
    const rels = [...CHECK];
    const server = localServerRel();
    if (server) rels.push(server);
    for (const rel of rels) {
      const abs = join(root, rel);
      assert.ok(existsSync(abs), `missing ${rel}`);
      const checked = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
      assert.equal(checked.status, 0, `${rel}\n${checked.stderr}`);
    }
  });

  test('first-party JavaScript modules parse with node --check', { timeout: 120_000 }, () => {
    const files = listSourceFiles(root);
    assert.ok(files.length >= 10, `expected many js modules, found ${files.length}`);
    const failures = [];
    for (const file of files) {
      const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        timeout: 20000,
        env: childEnv(),
      });
      if (result.status !== 0) {
        const text = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(0, 400);
        failures.push(`${relative(root, file)}: ${text || result.error?.message || 'check failed'}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test('posix entry scripts pass sh -n', () => {
    for (const rel of ['install.sh', 'scripts/tp-start.sh', 'scripts/tp-stop.sh']) {
      const abs = join(root, rel);
      assert.ok(existsSync(abs), rel);
      const checked = spawnSync('sh', ['-n', abs], { encoding: 'utf8' });
      assert.equal(checked.status, 0, `${rel}\n${checked.stderr}`);
    }
  });

  test('library modules import in a short-lived subprocess', { timeout: 60_000 }, () => {
    for (const rel of IMPORTS) {
      const result = spawnImport(join(root, rel));
      assert.equal(result.status, 0, `${rel}\n${detail(result)}`);
      const line = String(result.stdout ?? '').trim().split('\n').filter(Boolean).pop();
      let names;
      try {
        names = JSON.parse(line);
      } catch {
        assert.fail(`${rel} did not end with a JSON export list\n${detail(result)}`);
      }
      assert.ok(Array.isArray(names), rel);
      assert.ok(names.length > 0, `${rel} has no exports`);
      for (const name of REQUIRED[rel] ?? []) {
        assert.ok(names.includes(name), `${rel} missing ${name}; got ${names.join(',')}`);
      }
    }
  });

  test('Store opens a temp ledger and creates one space', () => {
    const dir = join(home, 'ledger');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'ledger.json');
    assert.ok(file.startsWith(home));
    const store = new Store(file);
    const space = store.create({ name: 'smoke' });
    assert.equal(space.name, 'smoke');
    assert.equal(space.profileId, 'agent');
    assert.equal(space.pages.p1.targetId, null);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(space.id)?.name, 'smoke');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.nextSpaceId, space.id + 1);
    assert.equal(saved.spaces[String(space.id)].name, 'smoke');
    store.deleteSpace(space.id);
    assert.equal(store.list().length, 0);
    assert.equal(store.get(space.id), null);
  });

  test('reaper and buildPlan keep an empty live set untouched', () => {
    const info = classifySpace(minSpace(), { liveTargets: ['T-smoke'], now: NOW });
    assert.equal(info.kind, 'unbound');
    const plan = planReap({ spaces: [minSpace()], liveTargetIds: [], now: NOW });
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
    const applied = applyReapPlan({
      deleteSpace() { throw new Error('deleteSpace should not run'); },
      removePage() { throw new Error('removePage should not run'); },
    }, plan);
    assert.deepEqual(applied, { closedSpaces: [], droppedPages: [] });
    const viaCli = buildPlan(JSON.stringify({
      spaces: [minSpace()],
      liveTargetIds: [],
      now: NOW,
    }));
    assert.equal(viaCli.reason, 'no-live-targets');
    assert.deepEqual(viaCli.closeSpaces, []);
    const emptyViaCli = buildPlan('{"spaces":[],"liveTargetIds":[]}');
    assert.equal(emptyViaCli.reason, 'no-live-targets');
    assert.equal(emptyViaCli.stats.examined, 0);
  });

  test('reaper cli prints usage and a minimal plan', () => {
    const payload = JSON.stringify({
      spaces: [minSpace()],
      liveTargetIds: [],
      now: NOW,
    });
    const empty = run(['fmb_feature2/cli.js'], { input: '' });
    assert.equal(empty.status, 2, detail(empty));
    assert.match(empty.stderr, /usage: node fmb_feature2\/cli\.js/);
    assert.equal((empty.stdout || '').trim(), '');

    const ok = run(['fmb_feature2/cli.js'], { input: `${payload}\n` });
    assert.equal(ok.status, 0, detail(ok));
    const plan = JSON.parse(ok.stdout);
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
  });

  test('browser CLIs print a version offline and help when the source exits early', () => {
    for (const rel of ['bin/tp-browser.js', 'bin/ego-browser.js']) {
      const src = readFileSync(join(root, rel), 'utf8');
      const version = run([rel, 'version'], { timeout: 3000 });
      assert.equal(version.status, 0, `${rel} version\n${detail(version)}`);
      const text = `${version.stdout}\n${version.stderr}`;
      assert.match(text, /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/);
      assert.doesNotMatch(text, /sk-|ghp_|xox[baprs]-/);
      const helpArg = pickSafeArg(src, ['--help', 'help', '-h']);
      if (helpArg) {
        const help = run([rel, helpArg], { timeout: 3000 });
        assert.equal(help.status, 0, `${rel} ${helpArg}\n${detail(help)}`);
        const helpText = `${help.stdout}\n${help.stderr}`;
        assert.match(helpText, /usage|help|version|status|doctor|nodejs|skill|tp-browser|ego-browser/i);
        assert.doesNotMatch(helpText, /sk-|ghp_|xox[baprs]-/);
      }
    }
  });
});
