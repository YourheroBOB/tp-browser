import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHub } from '../daemon/page-ops.js';

test('page.click clickCount 2 sends CDP clickCount 1 then 2 on press and release', async () => {
  const mouse = [];
  const hub = Object.create(BrowserHub.prototype);
  hub.cdp = {
    send(method, params) {
      if (method === 'Input.dispatchMouseEvent') mouse.push(params);
      return Promise.resolve({});
    },
  };
  hub.sessions = new Map([['t1', { sessionId: 'sid-1', dialogs: [] }]]);
  hub.popupsSeen = [];
  hub.call = async (_targetId, helper) => {
    if (helper === 'resolve') return { count: 1, hid: 'h1' };
    if (helper === 'ensureVisible') return { x: 0, y: 0, cx: 12, cy: 34 };
    throw new Error(`unexpected helper ${helper}`);
  };

  await hub.click('t1', '#submit', { clickCount: 2 });

  const presses = mouse.filter((e) => e.type === 'mousePressed').map((e) => e.clickCount);
  const releases = mouse.filter((e) => e.type === 'mouseReleased').map((e) => e.clickCount);
  assert.deepEqual(presses, [1, 2]);
  assert.deepEqual(releases, [1, 2]);
});
