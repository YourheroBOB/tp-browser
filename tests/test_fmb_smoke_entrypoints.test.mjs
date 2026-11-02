// tests/test_fmb_smoke_entrypoints.test.mjs
// FMB 冒煙測試：模組可匯入、主要進入點可在「離線 + 假設定」下啟動，並正確回應
// help／version／最小輸入（daemon 不存在時的優雅失敗）。
//
// 設計原則（刻意的保守選擇）：
//   1. 全程離線：只使用 loopback 上一個「確認已關閉」的埠號，不連線任何正式服務。
//   2. 假憑證只使用明顯假字串 FAKE_VALUE_FOR_TEST，且只寫在暫存資料夾裡。
//   3. 所有檔案操作都在 mkdtempSync(tmpdir()) 內，測試結束即刪除；不讀寫 repo 以外的真實使用者資料。
//   4. 不啟動 daemon（避免綁埠／拉起瀏覽器）：daemon 進入點以 `node --check` 驗證可解析即可。
//   5. 不重複既有 tests/test_fmb_*.test.mjs 與 fmb_feature2/*.test.js 的功能測試
//      （那些已測 CDP、keys、store、profile-init、reaper 邏輯與乾跑 CLI 的行為）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_TP = join(ROOT, 'bin', 'tp-browser.js');
const CLI_EGO = join(ROOT, 'bin', 'ego-browser.js');
const PARSE_ROOTS = ['bin', 'daemon', 'lib', 'fmb_feature2', 'tools', 'tests'];

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tp-fmb-smoke-'));
after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// 取得一個「剛剛還空著、現在已關閉」的 loopback 埠號，讓 CLI 一定連不到 daemon。
async function closedLoopbackPort() {
  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const PORT = await closedLoopbackPort();

// 建立隔離的 HOME，內含假 token 與假 daemon 設定（全部在 tmpdir 內）。
function fakeHome() {
  const home = mkdtempSync(join(TMP_ROOT, 'home-'));
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'token'), 'FAKE_VALUE_FOR_TEST', { mode: 0o600 });
  writeFileSync(
    join(dataDir, 'daemon.json'),
    JSON.stringify({ port: PORT, chromePort: PORT, token: 'FAKE_VALUE_FOR_TEST' }),
  );
  return home;
}

function isolatedEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    EGO_LINUX_DATA_DIR: join(home, '.local', 'share', 'ego-linux'),
    TP_DAEMON_PORT: String(PORT),
    EGO_DAEMON_PORT: String(PORT),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function runNode(scriptPath, args, { env, input, timeout = 30000 } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    env,
    input,
    encoding: 'utf8',
    timeout,
  });
}

function summarize(res) {
  const cut = (v) => String(v ?? '').trim().slice(0, 600);
  return (
    `\n  exit=${res.status} signal=${res.signal} spawnError=${res.error?.code ?? ''}` +
    `\n  stdout: ${cut(res.stdout)}` +
    `\n  stderr: ${cut(res.stderr)}`
  );
}

const MODULE_LOAD_FAILURE = /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNSUPPORTED_DIR_IMPORT/;

function listJsFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('smoke: package.json 的 bin 進入點與 engines 契約完整', () => {
  const pkgPath = join(ROOT, 'package.json');
  assert.ok(existsSync(pkgPath), '找不到 package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.type, 'module', 'package.json 應為 ESM（type: module）');
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+/, `version 應為 semver，實際：${pkg.version}`);
  assert.match(String(pkg.engines?.node ?? ''), />=\s*22/, 'engines.node 應維持 >= 22');

  const bins = pkg.bin ?? {};
  const names = Object.keys(bins);
  assert.ok(names.length >= 4, `bin 至少應有 4 個進入點，實際：${names.join(', ')}`);
  assert.ok(names.includes('tp-browser'), 'bin 應包含 tp-browser');
  assert.ok(names.includes('ego-browser'), 'bin 應包含 ego-browser 相容別名');

  for (const name of names) {
    const target = join(ROOT, bins[name]);
    assert.ok(existsSync(target), `bin "${name}" 指向不存在的檔案：${bins[name]}`);
    assert.ok(statSync(target).size > 0, `bin "${name}" 指向空檔案：${bins[name]}`);
  }
});

test('smoke: repo 內所有 JS/MJS 模組皆可被 Node 解析（不執行、不連網）', (t) => {
  const files = [];
  for (const rel of PARSE_ROOTS) listJsFiles(join(ROOT, rel), files);
  assert.ok(files.length >= 20, `應掃到至少 20 個 JS/MJS 檔，實際 ${files.length}`);

  const fallbackDir = mkdtempSync(join(TMP_ROOT, 'check-'));
  t.after(() => rmSync(fallbackDir, { recursive: true, force: true }));

  const esmDetectionHint = /Cannot use import statement outside a module|Unexpected token 'export'/;
  const failures = [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    let res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 20000 });

    if (res.status !== 0 && esmDetectionHint.test(String(res.stderr ?? ''))) {
      // 少數 Node 版本對 --check 的 ESM 偵測較保守：複製成 .mjs 後重試（只寫入暫存目錄）。
      const copy = join(fallbackDir, `module-${i}.mjs`);
      writeFileSync(copy, readFileSync(file));
      res = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8', timeout: 20000 });
    }

    if (res.status !== 0) {
      const rel = file.startsWith(ROOT) ? `.${file.slice(ROOT.length)}` : file;
      failures.push(`${rel}\n${String(res.stderr ?? '').trim().slice(0, 300)}`);
    }
  }

  assert.deepEqual(failures, [], `有 ${failures.length} 個模組無法被解析：\n${failures.join('\n\n')}`);
});

test('smoke: 核心模組可在離線下 import，並匯出預期符號', async () => {
  const url = (rel) => pathToFileURL(join(ROOT, rel)).href;

  const cdp = await import(url('daemon/cdp.js'));
  assert.equal(typeof cdp.Cdp, 'function', 'daemon/cdp.js 應匯出 Cdp');
  assert.equal(typeof cdp.CdpError, 'function', 'daemon/cdp.js 應匯出 CdpError');
  assert.equal(typeof cdp.once, 'function', 'daemon/cdp.js 應匯出 once');
  assert.ok(new cdp.CdpError('smoke.method', { message: 'fake' }) instanceof Error, 'CdpError 應繼承 Error');

  const keys = await import(url('daemon/keys.js'));
  for (const fn of ['isModifier', 'modifierBit', 'keyDescriptor', 'parseChord']) {
    assert.equal(typeof keys[fn], 'function', `daemon/keys.js 缺少匯出 ${fn}`);
  }

  const store = await import(url('daemon/store.js'));
  assert.equal(typeof store.Store, 'function', 'daemon/store.js 應匯出 Store');

  const reaper = await import(url('fmb_feature2/reaper.js'));
  for (const fn of ['planReap', 'classifySpace', 'applyReapPlan', 'toTargetSet', 'pageEntries']) {
    assert.equal(typeof reaper[fn], 'function', `fmb_feature2/reaper.js 缺少匯出 ${fn}`);
  }
  assert.equal(typeof reaper.DEFAULT_POLICY, 'object', 'fmb_feature2/reaper.js 應匯出 DEFAULT_POLICY');
  assert.ok(Object.isFrozen(reaper.DEFAULT_POLICY), 'DEFAULT_POLICY 應為凍結物件');

  const reaperCli = await import(url('fmb_feature2/cli.js'));
  assert.equal(typeof reaperCli.buildPlan, 'function', 'fmb_feature2/cli.js 應匯出 buildPlan');
});

test('smoke: CLI version 在隔離 HOME／假 token 下回應版本號（tp-browser 與 ego-browser）', () => {
  const env = isolatedEnv(fakeHome());

  for (const [label, cli] of [
    ['tp-browser', CLI_TP],
    ['ego-browser', CLI_EGO],
  ]) {
    const res = runNode(cli, ['version'], { env, timeout: 30000 });
    assert.doesNotMatch(String(res.stderr ?? ''), MODULE_LOAD_FAILURE, `${label} version 載入模組失敗${summarize(res)}`);
    assert.equal(res.status, 0, `${label} version 應以退出碼 0 結束${summarize(res)}`);
    assert.match(`${res.stdout ?? ''}${res.stderr ?? ''}`, /\d+\.\d+\.\d+/, `${label} version 應輸出 x.y.z 版本號${summarize(res)}`);
  }
});

test('smoke: CLI help／--help 可離線結束並輸出用法（不掛住、不缺模組）', () => {
  const env = isolatedEnv(fakeHome());

  for (const args of [['help'], ['--help']]) {
    const res = runNode(CLI_TP, args, { env, timeout: 30000 });
    const shown = args.join(' ');
    assert.notEqual(res.status, null, `tp-browser ${shown} 不應逾時或被強制終止（signal=${res.signal}）${summarize(res)}`);
    assert.ok(
      `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().length > 0,
      `tp-browser ${shown} 應有輸出（用法說明或明確錯誤）${summarize(res)}`,
    );
    assert.doesNotMatch(String(res.stderr ?? ''), MODULE_LOAD_FAILURE, `tp-browser ${shown} 載入模組失敗${summarize(res)}`);
  }
});

test('smoke: 需要 daemon 的指令在 daemon 不存在時優雅失敗（不崩潰、不掛住）', () => {
  const env = isolatedEnv(fakeHome());

  const status = runNode(CLI_TP, ['status'], { env, timeout: 40000 });
  assert.doesNotMatch(String(status.stderr ?? ''), MODULE_LOAD_FAILURE, `tp-browser status 載入模組失敗${summarize(status)}`);
  assert.notEqual(status.status, null, `tp-browser status 不應逾時或被強制終止（signal=${status.signal}）${summarize(status)}`);
  assert.ok(
    `${status.stdout ?? ''}${status.stderr ?? ''}`.trim().length > 0,
    `tp-browser status 在 daemon 不存在時仍應有可讀輸出${summarize(status)}`,
  );

  // 最小輸入：透過 stdin 餵一段無害腳本，daemon 不在線時應回報錯誤而不是靜默或崩潰。
  const minimal = runNode(CLI_TP, ['nodejs'], {
    env,
    input: 'console.log("FMB_SMOKE_MINIMAL_INPUT");\n',
    timeout: 40000,
  });
  assert.doesNotMatch(String(minimal.stderr ?? ''), MODULE_LOAD_FAILURE, `tp-browser nodejs 載入模組失敗${summarize(minimal)}`);
  assert.notEqual(minimal.status, null, `tp-browser nodejs 不應逾時或被強制終止（signal=${minimal.signal}）${summarize(minimal)}`);
  assert.ok(
    `${minimal.stdout ?? ''}${minimal.stderr ?? ''}`.trim().length > 0,
    `tp-browser nodejs 在 daemon 不存在時仍應有可讀輸出${summarize(minimal)}`,
  );
});
