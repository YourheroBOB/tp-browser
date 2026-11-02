import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tp-bug-goto-networkidle-'));
const downloadsDir = mkdtempSync(join(tmpdir(), 'tp-bug-goto-networkidle-dl-'));
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

const { BrowserHub } = await import('../daemon/page-ops.js');

function fakeCdp() {
  return {
    onEvent() { return () => {}; },
    send(method, params = {}) {
      if (method === 'Page.navigate') {
        return Promise.resolve({ frameId: 'frame-1', url: params.url });
      }
      if (method === 'Browser.getVersion') {
        return Promise.resolve({ userAgent: 'Chrome/120.0.0', product: 'Chrome/120.0.0' });
      }
      return Promise.resolve({});
    },
  };
}

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevProfile;
  rmSync(home, { recursive: true, force: true });
  rmSync(downloadsDir, { recursive: true, force: true });
});

test('goto networkidle does not succeed on quiet time from before this navigation', async () => {
  const hub = new BrowserHub(fakeCdp(), {
    downloadsDir,
    onPush() {},
    daemonPort: 9772,
  });
  clearInterval(hub._sweepTimer);
  hub.sessions.set('t1', {
    sessionId: 'sid-1',
    url: 'about:blank',
    title: '',
    net: new Set(),
    netQuietAt: Date.now() - 10_000,
    frames: new Set(),
    dialogs: [],
    choosers: [],
    events: [],
    isPopup: false,
    domReady: false,
    uaCleaned: true,
    agentNavigating: false,
    attachedAt: Date.now(),
  });

  await assert.rejects(
    () => hub.goto('t1', 'https://example.test/next', { waitUntil: 'networkidle', timeout: 400 }),
    (err) => {
      assert.equal(err.name, 'NavigationError');
      assert.match(err.message, /networkidle/);
      return true;
    },
  );
});
