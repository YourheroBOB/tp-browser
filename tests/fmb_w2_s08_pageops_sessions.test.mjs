import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep every file the hub may touch (cookie / storage / tabs vaults) inside a
// throwaway directory: the test must never read or write the real home.
const isolatedHome = mkdtempSync(join(tmpdir(), 'fmb-w2-s08-pageops-'));
mkdirSync(join(isolatedHome, '.local', 'share', 'ego-linux'), { recursive: true });
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

let BrowserHub;
try {
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  ({ BrowserHub } = await import('../daemon/page-ops.js'));
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
}

after(() => rmSync(isolatedHome, { recursive: true, force: true }));

// Minimal stand-in for daemon/cdp.js: only the three members BrowserHub uses.
class FakeCdp {
  events = null;
  close = null;

  send() {
    return Promise.resolve({});
  }

  onEvent(callback) {
    this.events = callback;
  }

  onClose(callback) {
    this.close = callback;
  }

  emit(method, params) {
    assert.equal(typeof this.events, 'function', 'BrowserHub should register its event handler');
    this.events({ sessionId: null, method, params });
  }
}

const settleEventWork = () => new Promise((resolve) => setImmediate(resolve));

test('BrowserHub tracks target sessions through attach, info change, detach and destroy', async () => {
  const downloadsDir = join(isolatedHome, 'downloads');
  mkdirSync(downloadsDir, { recursive: true });
  const pushes = [];
  const cdp = new FakeCdp();
  const hub = new BrowserHub(cdp, {
    downloadsDir,
    onPush: (targetId, kind, payload) => pushes.push({ targetId, kind, payload }),
    daemonPort: 9772,
  });

  try {
    // 1) attach -> session appears with url/title from the target info
    cdp.emit('Target.attachedToTarget', {
      sessionId: 'session-popup',
      targetInfo: {
        targetId: 'target-popup',
        type: 'page',
        url: 'about:blank',
        title: 'Initial popup',
        openerId: 'target-opener',
      },
    });
    await settleEventWork();

    const popup = hub.sessions.get('target-popup');
    assert.ok(popup, 'attach should add the target session');
    assert.equal(popup.sessionId, 'session-popup');
    assert.equal(popup.url, 'about:blank');
    assert.equal(popup.title, 'Initial popup');
    assert.equal(popup.isPopup, true, 'a target with openerId should be flagged as a popup');
    assert.ok(
      pushes.some((push) => push.targetId === 'target-popup' && push.payload?.openerId === 'target-opener'),
      'popup push should include the openerId',
    );

    // 2) targetInfoChanged -> url and title are refreshed in place
    cdp.emit('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'target-popup',
        type: 'page',
        url: 'http://127.0.0.1:9772/updated',
        title: 'Updated popup',
        openerId: 'target-opener',
      },
    });
    await settleEventWork();

    assert.equal(hub.sessions.get('target-popup')?.url, 'http://127.0.0.1:9772/updated');
    assert.equal(hub.sessions.get('target-popup')?.title, 'Updated popup');

    // 3) detaching something we never tracked must be harmless
    assert.doesNotThrow(() => {
      cdp.emit('Target.detachedFromTarget', {
        sessionId: 'unknown-session',
        targetId: 'unknown-target',
      });
    }, 'detaching an unknown target should be harmless');
    cdp.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'unknown-target', type: 'page', url: 'about:blank', title: 'ghost' },
    });
    assert.equal(hub.sessions.has('unknown-target'), false, 'unknown targets must not be created');

    // If the session id is the only reliable key, detach must still remove the entry.
    cdp.emit('Target.detachedFromTarget', { sessionId: 'session-popup' });
    await settleEventWork();
    assert.equal(hub.sessions.has('target-popup'), false, 'detach should remove the target session');

    // 4) targetDestroyed -> the session is removed as well
    cdp.emit('Target.attachedToTarget', {
      sessionId: 'session-destroyed',
      targetInfo: {
        targetId: 'target-destroyed',
        type: 'page',
        url: 'http://127.0.0.1:9772/keep',
        title: 'Target to destroy',
      },
    });
    await settleEventWork();
    assert.ok(hub.sessions.has('target-destroyed'), 'the second attach should add its session');

    cdp.emit('Target.targetDestroyed', { targetId: 'target-destroyed' });
    await settleEventWork();
    assert.equal(hub.sessions.has('target-destroyed'), false, 'destroy should remove the target session');
    assert.equal(hub.sessions.size, 0, 'no stale sessions should survive');
  } finally {
    clearInterval(hub._sweepTimer);
  }
});
