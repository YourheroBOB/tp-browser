import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REPO_ROOT = new URL('../', import.meta.url);
const CLI_FILES = ['bin/tp-browser.js', 'bin/ego-browser.js'];

function readRepoFile(relativePath) {
  return readFile(new URL(relativePath, REPO_ROOT), 'utf8');
}

for (const cliFile of CLI_FILES) {
  test(`${cliFile}: Windows temporary ESM regression uses a file URL and strips UTF-8 BOM`, async () => {
    const source = await readRepoFile(cliFile);

    assert.ok(
      source.includes(".replace(/^\\uFEFF/, '')"),
      `${cliFile} must remove a leading UTF-8 BOM before importing agent code`,
    );
    assert.match(
      source,
      /await import\(pathToFileURL\(tmp\)\.href\)/,
      `${cliFile} must convert the temporary script path with pathToFileURL`,
    );
    assert.doesNotMatch(
      source,
      /await import\(tmp\)/,
      `${cliFile} must not pass a native filesystem path directly to dynamic import`,
    );
  });
}

for (const cliFile of CLI_FILES) {
  test(`${cliFile}: temporary agent code regression keeps private mode and removes the file`, async () => {
    const source = await readRepoFile(cliFile);

    assert.ok(
      source.includes("mkdtempSync(join(tmpdir(), 'tp-run-'))"),
      `${cliFile} must execute agent code from an isolated temporary directory`,
    );
    assert.ok(
      source.includes('writeFileSync(tmp, code, { mode: 0o600 })'),
      `${cliFile} must create the temporary script with owner-only permissions`,
    );
    assert.ok(
      source.includes('rmSync(tmpDir, { recursive: true, force: true })'),
      `${cliFile} must remove the temporary script directory`,
    );

    const cleanupIndex = source.indexOf('rmSync(tmpDir, { recursive: true, force: true })');
    const exitIndex = source.indexOf('process.exit(exitCode)');
    assert.ok(cleanupIndex >= 0);
    assert.ok(exitIndex >= 0);
    assert.ok(
      cleanupIndex < exitIndex,
      `${cliFile} must clean the temporary script before terminating the CLI`,
    );
  });
}

for (const cliFile of CLI_FILES) {
  test(`${cliFile}: alternate daemon and Chrome ports regression is honored`, async () => {
    const source = await readRepoFile(cliFile);

    assert.ok(
      source.includes('if (p === 9774) return 9774;'),
      `${cliFile} must honor daemon.json port 9774`,
    );
    assert.ok(
      source.includes('if (p === 9775) return 9775;'),
      `${cliFile} must honor daemon.json Chrome port 9775`,
    );
    assert.ok(
      source.includes("port === 9774 ? 'http://127.0.0.1:9774' : 'http://127.0.0.1:9772'"),
      `${cliFile} must route RPC requests to the alternate loopback daemon`,
    );
    assert.ok(
      source.includes("chromePort === 9775 ? 'http://127.0.0.1:9775/json/version' : 'http://127.0.0.1:9773/json/version'"),
      `${cliFile} must query the alternate loopback Chrome endpoint`,
    );
  });
}

test('POSIX launcher regression maps --alt-port to an isolated daemon and Chrome port pair', async () => {
  const source = await readRepoFile('scripts/tp-start.sh');

  assert.match(source, /DAEMON_PORT=9772\s*\n\s*CHROME_PORT=9773/);
  assert.match(source, /DAEMON_PORT=9774\s*\n\s*CHROME_PORT=9775/);
  assert.ok(
    source.includes('--alt-port|-AltPort'),
    'the POSIX launcher must continue accepting the alternate-port option',
  );
});

test('Windows launcher regression switches to alternate ports when port 9773 belongs to Linux', async () => {
  const source = await readRepoFile('scripts/ego-start.ps1');

  assert.ok(source.includes('$DaemonPort = if ($UseAlt) { 9774 } else { 9772 }'));
  assert.ok(source.includes('$ChromePort = if ($UseAlt) { 9775 } else { 9773 }'));
  assert.ok(
    source.includes("if ($v9773 -and $v9773.'User-Agent' -match 'Linux')"),
    'a Linux-owned CDP endpoint must be detected before choosing ports',
  );
  assert.ok(source.includes('$UseAlt = $true'));
});

test('POSIX launcher regression detaches the daemon and browser from inherited stdio', async () => {
  const source = await readRepoFile('scripts/tp-start.sh');

  assert.ok(source.includes('detached: true'));
  assert.ok(source.includes('stdio: ["ignore", out, out]'));
  assert.ok(source.includes('child.unref();'));
});

test('Windows launcher regression starts the daemon through WMI instead of a pipeline-inheriting process', async () => {
  const source = await readRepoFile('scripts/ego-start.ps1');
  const sectionStart = source.indexOf('# 6. Launch ego-browserd.js');
  const sectionEnd = source.indexOf('# 7. Launch Chrome/Edge');
  assert.ok(sectionStart >= 0, 'daemon launch section must exist');
  assert.ok(sectionEnd > sectionStart, 'Chrome launch section must follow the daemon section');

  const daemonSection = source.slice(sectionStart, sectionEnd);
  assert.match(
    daemonSection,
    /Invoke-CimMethod\s+-ClassName\s+Win32_Process\s+-MethodName\s+Create/,
    'the daemon must be created through Win32_Process.Create',
  );
  assert.doesNotMatch(
    daemonSection,
    /Start-Process/,
    'the daemon launch must not inherit a captured stdout or stderr pipeline',
  );
});

test('Headless Chrome regression removes HeadlessChrome from both UA client-hint lists', async () => {
  const source = await readRepoFile('daemon/page-ops.js');

  assert.ok(source.includes('Browser.getVersion'));
  assert.ok(source.includes('Network.setUserAgentOverride'));
  assert.ok(source.includes('userAgentMetadata'));
  assert.ok(source.includes('brands'));
  assert.ok(source.includes('fullVersionList'));
  assert.ok(source.includes('HeadlessChrome'));
  assert.ok(source.includes('Google Chrome'));
});

test('Headless Chrome regression overrides navigator.webdriver for newly created documents', {
  skip: 'Known gap: daemon/page-ops.js 目前無法提供可辨識且可驗證的 navigator.webdriver 覆寫；本任務不得修改產品原始碼，待產品修正或注入邏輯可注入後解除。',
}, async () => {
  const source = await readRepoFile('daemon/page-ops.js');

  assert.ok(source.includes('Page.addScriptToEvaluateOnNewDocument'));

  const directOverride = /navigator\s*(?:\.\s*webdriver|\[\s*['"]webdriver['"]\s*\])\s*=\s*(?:false|undefined)\b/.test(source);
  const descriptorOverride = /(?:Object|Reflect)\s*\.\s*defineProperty\s*\(\s*(?:navigator|Navigator\s*\.\s*prototype)\s*,\s*['"]webdriver['"][\s\S]{0,500}?(?:false|undefined)\b/.test(source);

  assert.ok(
    directOverride || descriptorOverride,
    'the injected script must hide navigator.webdriver by direct assignment or a property descriptor',
  );
});
