import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 8000,
  });
}

function assertProcessSucceeded(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message ?? ''}`);
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test('shared runtime modules import without starting a service', () => {
  const modules = [
    'daemon/cdp.js',
    'daemon/keys.js',
    'daemon/page-ops.js',
    'daemon/store.js',
    'lib/sdk.js',
  ];
  const urls = modules.map((modulePath) =>
    pathToFileURL(`${repoRoot}${modulePath}`).href
  );
  const script = `
    for (const url of ${JSON.stringify(urls)}) {
      const namespace = await import(url);
      if (!namespace || typeof namespace !== 'object') {
        throw new Error('Module did not provide an import namespace: ' + url);
      }
    }
    console.log('IMPORTS_OK');
  `;

  const result = runNode(['--input-type=module', '-e', script]);
  assertProcessSucceeded(result, 'shared module import smoke test');
  assert.match(result.stdout, /IMPORTS_OK/);
});

test('CLI entrypoints show help and version without using the network', async (t) => {
  for (const entrypoint of ['bin/tp-browser.js', 'bin/ego-browser.js']) {
    await t.test(`${entrypoint}: no-argument help`, () => {
      const absolutePath = `${repoRoot}${entrypoint}`;
      const script = `
        globalThis.fetch = () => {
          throw new Error('network access forbidden in smoke test');
        };
        process.argv = ['node', ${JSON.stringify(absolutePath)}];
        await import(${JSON.stringify(pathToFileURL(absolutePath).href)});
      `;

      const result = runNode(['--input-type=module', '-e', script]);
      assertProcessSucceeded(result, `${entrypoint} help`);
      assert.match(result.stdout, /usage:/i);
      assert.doesNotMatch(result.stderr, /network access forbidden/);
    });

    await t.test(`${entrypoint}: version`, () => {
      const absolutePath = `${repoRoot}${entrypoint}`;
      const script = `
        globalThis.fetch = () => {
          throw new Error('network access forbidden in smoke test');
        };
        process.argv = ['node', ${JSON.stringify(absolutePath)}, 'version'];
        await import(${JSON.stringify(pathToFileURL(absolutePath).href)});
      `;

      const result = runNode(['--input-type=module', '-e', script]);
      assertProcessSucceeded(result, `${entrypoint} version`);
      // 不鎖死特定版號（CLI 顯示的版號與 package.json 可能暫時不一致，屬已知落差），
      // 只驗證能印出產品名稱與 semver 形式版本，避免版本升號時冒煙測試誤紅。
      assert.match(result.stdout, /TooPower Browser \(tp-browser\) \d+\.\d+\.\d+/);
      assert.doesNotMatch(result.stderr, /network access forbidden/);
    });
  }
});

test('side-effect-sensitive runtime entrypoints pass syntax checks', () => {
  const files = [
    'daemon/ego-browserd.js',
    'daemon/inpage.agent.js',
    'daemon/tp-browserd.js',
    'tools/profile-init.js',
  ];

  for (const file of files) {
    const result = runNode(['--check', `${repoRoot}${file}`]);
    assertProcessSucceeded(result, `syntax check: ${file}`);
  }
});
