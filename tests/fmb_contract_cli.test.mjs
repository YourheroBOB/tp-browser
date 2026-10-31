import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TP_BROWSER = fileURLToPath(
  new URL('../bin/tp-browser.js', import.meta.url),
);
const EGO_BROWSER = fileURLToPath(
  new URL('../bin/ego-browser.js', import.meta.url),
);

const PLATFORM_TAGS = {
  win32: 'tp-win / ego-win',
  darwin: 'tp-mac / ego-mac',
  linux: 'tp-linux / ego-linux',
};

function platformTag() {
  return PLATFORM_TAGS[process.platform] ?? 'tp-linux / ego-linux';
}

function runCli(path, args = []) {
  const result = spawnSync(process.execPath, [path, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('tp-browser and ego-browser version commands retain their exact format', () => {
  const expected = `TooPower Browser (tp-browser) 0.3.1 [${platformTag()} — 強到沒朋友]\n`;

  assert.equal(runCli(TP_BROWSER, ['version']), expected);
  assert.equal(runCli(EGO_BROWSER, ['version']), expected);
});

test('tp-browser help retains its complete stdout contract', () => {
  const expected = [
    `TooPower Browser / tp-browser (${platformTag()} — 強到沒朋友)`,
    'usage:',
    "  tp-browser nodejs -e 'code'       run an agent script (-e) or pipe one via stdin/heredoc (auto-starts if needed)",
    '  tp-browser start                  start headless background browser (alias: tp-start / ego-start)',
    '  tp-browser headed                 open visible GUI browser window for human login/Co-Riding (alias: tp-headed / ego-headed)',
    '  tp-browser stop                   stop browser & daemon (alias: tp-stop / ego-stop)',
    '  tp-browser status                 daemon + chrome health',
    '  tp-browser spaces                 list task spaces',
    '  tp-browser doctor                 diagnose and print fix commands',
    '  tp-browser skill                  print the AI Agent SKILL.md guide',
    '  tp-browser version                print version and platform build',
    '',
  ].join('\n');

  assert.equal(runCli(TP_BROWSER), expected);
  assert.equal(runCli(EGO_BROWSER), expected);
});

test('unknown CLI commands continue to fall back to the help output', () => {
  const help = runCli(TP_BROWSER);
  const unknown = runCli(TP_BROWSER, ['unknown-contract-command']);

  assert.equal(unknown, help);
});
