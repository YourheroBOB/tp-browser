// 離線冒煙：語法、模組可載入、CLI 在假設定下回應 help／version／空參數。
// 不連外網、不綁預設埠、不讀真實家目錄、不執行會殺程序或啟動瀏覽器的腳本。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'fmb-smoke-modules-'));
const preload = join(tmp, 'block-net.mjs');

const IMPORT_MODULES = [
  'daemon/cdp.js',
  'daemon/inpage.agent.js',
  'daemon/keys.js',
  'daemon/page-ops.js',
  'daemon/store.js',
  'lib/sdk.js',
  'fmb_feature2/cli.js',
  'fmb_feature2/reaper.js',
];

const SYNTAX_FILES = [
  ...IMPORT_MODULES,
  'bin/ego-browser.js',
  'bin/tp-browser.js',
  'daemon/ego-browserd.js',
  'daemon/tp-browserd.js',
  'tools/profile-init.js',
  'tests/serve.mjs',
  'install.sh',
  'scripts/tp-start.sh',
  'scripts/tp-stop.sh',
];

const CLI_BINS = ['bin/tp-browser.js', 'bin/ego-browser.js'];

const HELP_RE = /usage\s*:|用法|commands?\b|nodejs|doctor|\bskill\b|指令|子命令|\bstatus\b/i;

// Node 24 的 globalThis.navigator 只有 getter，直接賦值會在載入頁面腳本之前就拋 TypeError。
// 已存在的全域（navigator）沿用；缺的 DOM 全域才用 defineProperty 補上。
const FAKE_DOM = [
  'function defineMissing(name, value) {',
  '  if (name in globalThis && globalThis[name] != null) return;',
  '  try {',
  '    Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value });',
  '  } catch {',
  '    try { globalThis[name] = value; } catch { /* locked global */ }',
  '  }',
  '}',
  'defineMissing("window", globalThis);',
  'defineMissing("self", globalThis);',
  "defineMissing('navigator', { userAgent: 'smoke-browser', webdriver: false, language: 'en' });",
  'defineMissing("getComputedStyle", () => ({}));',
  'defineMissing("requestAnimationFrame", () => 0);',
  'defineMissing("cancelAnimationFrame", () => {});',
  'defineMissing("MutationObserver", class { observe() {} disconnect() {} takeRecords() { return []; } });',
  'defineMissing("document", {',
  "  readyState: 'complete',",
  '  documentElement: {},',
  '  body: {},',
  '  addEventListener() {},',
  '  removeEventListener() {},',
  '  querySelector() { return null; },',
  '  querySelectorAll() { return []; },',
  '  getElementById() { return null; },',
  '  createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },',
  '});',
].join('\n');

const PRELOAD = `
const makeErr = (name) => {
  const err = new Error('smoke-test blocked network call: ' + name);
  err.code = 'ENETUNREACH';
  return err;
};
async function patch(modName, keys) {
  let mod;
  try { mod = await import(modName); } catch { return; }
  const objs = [mod];
  if (mod && mod.default && typeof mod.default === 'object') objs.push(mod.default);
  for (const obj of objs) {
    for (const key of keys) {
      try { obj[key] = () => { throw makeErr(modName + '.' + key); }; } catch { /* non-writable */ }
    }
  }
}
await patch('node:net', ['connect', 'createConnection']);
await patch('node:dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6']);
await patch('node:http', ['request', 'get']);
await patch('node:https', ['request', 'get']);
await patch('node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
try {
  const dns = await import('node:dns');
  const promises = dns.promises || (dns.default && dns.default.promises);
  if (promises) {
    try { promises.lookup = async () => { throw makeErr('dns.promises.lookup'); }; } catch { /* ignore */ }
  }
} catch { /* ignore */ }
try { globalThis.fetch = async () => { throw makeErr('fetch'); }; } catch { /* ignore */ }
try {
  const httpNs = await import('node:http');
  const http = httpNs.default || httpNs;
  if (http.Server && http.Server.prototype) {
    http.Server.prototype.listen = function () { throw makeErr('http.Server.listen'); };
  }
} catch { /* ignore */ }
try {
  const netNs = await import('node:net');
  const net = netNs.default || netNs;
  if (net.Server && net.Server.prototype) {
    net.Server.prototype.listen = function () { throw makeErr('net.Server.listen'); };
  }
} catch { /* ignore */ }
try {
  const osNs = await import('node:os');
  const osObj = osNs.default || osNs;
  const origUserInfo = osObj.userInfo.bind(osObj);
  const home = process.env.HOME || osObj.homedir();
  const fakeHomedir = () => home;
  const fakeUserInfo = (opts) => {
    let info;
    try { info = origUserInfo(opts); } catch { info = { uid: -1, gid: -1, username: 'smoke', homedir: home, shell: null }; }
    return Object.assign({}, info, { homedir: home });
  };
  for (const obj of [osNs, osObj]) {
    try { obj.homedir = fakeHomedir; } catch { /* ignore */ }
    try { obj.userInfo = fakeUserInfo; } catch { /* ignore */ }
  }
} catch { /* ignore */ }
`;

writeFileSync(preload, PRELOAD);

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(TOKEN|SECRET|PASSWD|PASSWORD|COOKIE|CREDENTIAL|API_KEY)/i.test(key)) delete env[key];
  }
  delete env.NODE_OPTIONS;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  delete env.TP_BROWSER_BIN;
  env.HOME = home;
  env.USERPROFILE = home;
  env.HOMEDRIVE = '';
  env.HOMEPATH = home;
  env.XDG_CONFIG_HOME = join(home, 'xdg-config');
  env.XDG_DATA_HOME = join(home, 'xdg-data');
  env.XDG_CACHE_HOME = join(home, 'xdg-cache');
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  env.TMPDIR = home;
  env.TEMP = home;
  env.TMP = home;
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

function writeFakeSettings(home) {
  const data = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(join(data, 'logs'), { recursive: true });
  mkdirSync(join(data, 'profile-agent'), { recursive: true });
  mkdirSync(join(home, 'xdg-config'), { recursive: true });
  mkdirSync(join(home, 'xdg-data'), { recursive: true });
  mkdirSync(join(home, 'xdg-cache'), { recursive: true });
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
  writeFileSync(join(data, 'token'), 'FAKE_VALUE_FOR_TEST\n', { mode: 0o600 });
  writeFileSync(join(data, 'daemon.json'), '{"port":41731,"chromePort":41732}\n', { mode: 0o600 });
  const skillSrc = join(root, 'skills', 'tp-browser', 'SKILL.md');
  if (existsSync(skillSrc)) {
    for (const rel of ['app/skills/tp-browser/SKILL.md', 'skills/tp-browser/SKILL.md']) {
      const dest = join(data, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(skillSrc, dest);
    }
  }
}

function detail(r) {
  return [
    'status=' + r.status,
    'signal=' + (r.signal || ''),
    'error=' + (r.error ? r.error.message : ''),
    '--- stdout ---',
    String(r.stdout || '').slice(0, 2000),
    '--- stderr ---',
    String(r.stderr || '').slice(0, 2000),
  ].join('\n');
}

function combined(r) {
  return String(r.stdout || '') + '\n' + String(r.stderr || '');
}

function looksLikeCrash(out) {
  return /smoke-test blocked network call|ERR_MODULE_NOT_FOUND|SyntaxError|UnhandledPromise|EADDRINUSE|ECONNREFUSED/.test(out);
}

function runNode(args, home) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 8000,
    killSignal: 'SIGKILL',
    input: '',
    maxBuffer: 1024 * 1024,
    env: isolatedEnv(home),
  });
}

test('package.json bin 進入點存在且為 0.3.x', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'tp-browser');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.version, /^0\.3\.\d+$/);
  assert.deepEqual(
    Object.keys(pkg.bin).sort(),
    ['ego-browser', 'ego-browserd', 'tp-browser', 'tp-browserd'],
  );
  for (const rel of Object.values(pkg.bin)) {
    assert.equal(existsSync(join(root, rel)), true, rel);
  }
});

for (const rel of SYNTAX_FILES) {
  test('syntax ' + rel, { timeout: 15000 }, () => {
    const abs = join(root, rel);
    const r = rel.endsWith('.sh')
      ? spawnSync('sh', ['-n', abs], { encoding: 'utf8', timeout: 8000, input: '' })
      : spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 8000, input: '' });
    assert.equal(r.status, 0, detail(r));
  });
}

for (const rel of IMPORT_MODULES) {
  test('import ' + rel, { timeout: 15000 }, () => {
    const home = mkdtempSync(join(tmp, 'home-'));
    writeFakeSettings(home);
    const href = pathToFileURL(join(root, rel)).href;
    const wrap = join(tmp, 'wrap-' + rel.replace(/[^A-Za-z0-9]+/g, '_') + '.mjs');
    const lines = [];
    if (rel === 'daemon/inpage.agent.js') lines.push(FAKE_DOM);
    lines.push('const ns = await import(' + JSON.stringify(href) + ');');
    lines.push("if (!ns || typeof ns !== 'object') { console.error('not a module namespace'); process.exit(2); }");
    lines.push("console.log('SMOKE_EXPORTS ' + Object.keys(ns).sort().join(','));");
    writeFileSync(wrap, lines.join('\n'));
    const r = runNode([wrap], home);
    assert.equal(r.status, 0, detail(r));
    assert.match(String(r.stdout || ''), /SMOKE_EXPORTS/);
    assert.doesNotMatch(combined(r), /FAKE_VALUE_FOR_TEST/);
    assert.equal(looksLikeCrash(combined(r)), false, detail(r));
  });
}

function assertVersion(rel) {
  const home = mkdtempSync(join(tmp, 'home-'));
  writeFakeSettings(home);
  const r = runNode([join(root, rel), 'version'], home);
  const out = combined(r);
  assert.equal(r.status, 0, detail(r));
  assert.match(out, /0\.3\.\d+/);
  assert.doesNotMatch(out, /FAKE_VALUE_FOR_TEST/);
  assert.equal(looksLikeCrash(out), false, detail(r));
}

function assertHelp(rel) {
  const attempts = [];
  for (const args of [['help'], ['--help'], ['-h']]) {
    const home = mkdtempSync(join(tmp, 'home-'));
    writeFakeSettings(home);
    const r = runNode([join(root, rel), ...args], home);
    const out = combined(r);
    attempts.push(args.join(' ') + '\n' + detail(r));
    if ((r.status === 0 || r.status === 1 || r.status === 2)
      && HELP_RE.test(out)
      && !/FAKE_VALUE_FOR_TEST/.test(out)
      && !looksLikeCrash(out)) {
      return;
    }
  }
  assert.fail('help 沒有離線成功回應\n' + attempts.join('\n----\n'));
}

function assertNoArgs(rel) {
  const home = mkdtempSync(join(tmp, 'home-'));
  writeFakeSettings(home);
  const r = runNode([join(root, rel)], home);
  const out = combined(r);
  assert.ok(r.status === 0 || r.status === 1 || r.status === 2, detail(r));
  assert.match(out, HELP_RE, detail(r));
  assert.doesNotMatch(out, /FAKE_VALUE_FOR_TEST/);
  assert.equal(looksLikeCrash(out), false, detail(r));
}

function assertSkill(rel) {
  const home = mkdtempSync(join(tmp, 'home-'));
  writeFakeSettings(home);
  const r = runNode([join(root, rel), 'skill'], home);
  const out = combined(r);
  assert.equal(r.status, 0, detail(r));
  assert.ok(out.trim().length > 20, detail(r));
  assert.doesNotMatch(out, /FAKE_VALUE_FOR_TEST/);
  assert.equal(looksLikeCrash(out), false, detail(r));
}

for (const rel of CLI_BINS) {
  test(rel + ' version', { timeout: 15000 }, () => assertVersion(rel));
  test(rel + ' help', { timeout: 35000 }, () => assertHelp(rel));
  test(rel + ' no-args', { timeout: 15000 }, () => assertNoArgs(rel));
  test(rel + ' skill', { timeout: 15000 }, () => assertSkill(rel));
}
