import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const UTILITIES = ['dirname', 'mkdir', 'chmod', 'rm', 'grep', 'pwd', 'id'];

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Check the next standard location.
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function makeSandbox(t, psMode) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w2-s11-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const browser = join(root, 'fake-browser');
  const curlLog = join(root, 'curl.log');
  const nodeLog = join(root, 'node.log');
  const nodeStartMarker = join(root, 'node-started');
  const browserLog = join(root, 'browser.log');
  const browserMarker = join(root, 'browser-started');
  const pkillLog = join(root, 'pkill.log');

  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of UTILITIES) {
    symlinkSync(findExecutable(name), join(bin, name));
  }
  for (const path of [curlLog, nodeLog, browserLog, pkillLog]) {
    writeFileSync(path, '');
  }

  writeExecutable(
    join(bin, 'curl'),
    `#!/bin/sh
for arg do url=$arg; done
printf '%s\\n' "$url" >> "$CURL_LOG"
case "$url" in
  */health) printf '%s\\n' '{"chrome":true}' ;;
  */flush-and-close) printf '%s\\n' '{"ok":true}' ;;
esac
exit 0
`,
  );
  writeExecutable(
    join(bin, 'ps'),
    `#!/bin/sh
case "$PS_MODE" in
  headless)
    printf '%s\\n' \\
      "chrome --headless=new --user-data-dir=$HOME/.local/share/ego-linux/profile-agent" \\
      "chrome_crashpad_handler --database=$HOME/.local/share/ego-linux/profile-agent/Crashpad"
    ;;
  headed)
    printf '%s\\n' \\
      "chrome --user-data-dir=$HOME/.local/share/ego-linux/profile-agent"
    ;;
esac
`,
  );
  writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeExecutable(join(bin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  writeExecutable(
    join(bin, 'pkill'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PKILL_LOG"\nexit 0\n',
  );
  writeExecutable(
    join(bin, 'node'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$NODE_LOG"
if [ "\${1:-}" = "-e" ]; then
  : > "$NODE_START_MARKER"
  if [ "\${4:-}" = "$TP_BROWSER_BIN" ]; then
    shift 3
    "$@" >/dev/null 2>&1 || true
  fi
fi
exit 0
`,
  );
  writeExecutable(
    browser,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BROWSER_LOG"
: > "$BROWSER_MARKER"
exit 0
`,
  );

  return {
    home,
    bin,
    browser,
    curlLog,
    nodeStartMarker,
    browserMarker,
    env: {
      HOME: home,
      PATH: bin,
      PS_MODE: psMode,
      CURL_LOG: curlLog,
      NODE_LOG: nodeLog,
      NODE_START_MARKER: nodeStartMarker,
      BROWSER_LOG: browserLog,
      BROWSER_MARKER: browserMarker,
      PKILL_LOG: pkillLog,
      TP_BROWSER_BIN: browser,
    },
  };
}

function runHeaded(sandbox) {
  return spawnSync('/bin/sh', [SCRIPT, '--headed'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: sandbox.env,
  });
}

test(
  'tp-start --headed ignores headless Chrome and crashpad when deciding whether to return READY',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t, 'headless');
    const result = runHeaded(sandbox);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(sandbox.curlLog, 'utf8'), /\/flush-and-close/);
    assert.equal(existsSync(sandbox.nodeStartMarker), true);
    assert.equal(existsSync(sandbox.browserMarker), true);
  },
);

test(
  'tp-start --headed still returns early for an existing headed browser main process',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t, 'headed');
    const result = runHeaded(sandbox);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mode=headed/);
    assert.doesNotMatch(readFileSync(sandbox.curlLog, 'utf8'), /\/flush-and-close/);
    assert.equal(existsSync(sandbox.browserMarker), false);
    assert.equal(existsSync(sandbox.nodeStartMarker), false);
  },
);
