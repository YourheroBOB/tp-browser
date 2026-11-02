// tests/fmb_w10_s04_ego_browserd_file_perms.test.mjs
// Regression test for daemon/ego-browserd.js:
//   The daemon promises a 0700 data root (docs/README) and writes daemon.json with
//   `{ mode: 0o600 }`, but fs.mkdirSync()/fs.writeFileSync() only apply `mode` when the
//   target is *created*. A data dir or daemon.json left behind by an older, looser run
//   therefore kept its world-readable bits (e.g. 0755 / 0644), which also exposed the
//   ledger and downloads to other local users. The daemon must tighten them explicitly.
//
// The test pre-creates both with loose permissions, starts the daemon against an
// isolated HOME inside os.tmpdir(), and asserts they are tightened. All files live
// under the temp HOME; the daemon only ever fetches loopback (127.0.0.1:977x) which is
// refused here, so this never contacts a real service and reads/writes no repo-external
// path beyond its own tmp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url));
const POSIX = process.platform !== 'win32';

function dataDir(home) { return join(home, '.local', 'share', 'ego-linux'); }

function waitFor(fn, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v = false;
      try { v = fn(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for daemon to initialise'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function spawnDaemon(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // Neutralise any inherited port override so port/chromePort are deterministic.
  delete env.EGO_BROWSERD_PORT;
  return spawn(process.execPath, [DAEMON], { env, stdio: 'ignore' });
}

test('ego-browserd tightens a pre-existing 0755 data dir to 0700 and daemon.json to 0600', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w10-s04-home-'));
  const dd = dataDir(home);
  mkdirSync(dd, { recursive: true, mode: 0o755 });
  if (POSIX) { try { chmodSync(dd, 0o755); } catch {} }
  const daemonJson = join(dd, 'daemon.json');
  writeFileSync(daemonJson, JSON.stringify({ stale: true }), { mode: 0o644 });
  if (POSIX) { try { chmodSync(daemonJson, 0o644); } catch {} }

  const child = spawnDaemon(home);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });

  // Wait until daemon.json describes *this* run (pid matches the spawned process).
  // daemon.json is written synchronously during startup, before the HTTP listener, so
  // this resolves even if the default port happens to be busy in a parallel test.
  const info = await waitFor(() => {
    const parsed = JSON.parse(readFileSync(daemonJson, 'utf8'));
    return parsed && parsed.pid === child.pid ? parsed : false;
  });

  assert.equal(info.pid, child.pid, 'daemon.json must describe this run');
  assert.equal(typeof info.port, 'number');
  assert.ok([9772, 9774].includes(info.port), `unexpected daemon port ${info.port}`);
  assert.equal(info.chromePort, info.port === 9774 ? 9775 : 9773, 'chromePort must pair with port');
  assert.equal(typeof info.startedAt, 'string');

  // Token is generated next to it and must never be empty/blank.
  const tokenPath = join(dd, 'token');
  assert.ok(existsSync(tokenPath), 'token file must be created');
  const token = readFileSync(tokenPath, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/, 'token must be 24 random bytes hex-encoded');

  if (POSIX) {
    assert.equal(statSync(dd).mode & 0o777, 0o700, 'data dir must be 0700 even if it pre-existed');
    assert.equal(statSync(daemonJson).mode & 0o777, 0o600, 'daemon.json must be 0600 even if it pre-existed');
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600, 'token must be 0600');
  }
});
