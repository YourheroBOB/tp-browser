import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTargetInfoChanged, wantsDocumentTitleRefresh } from '../../daemon/page-title.js';

test('applyTargetInfoChanged writes title from Target.targetInfoChanged', () => {
  const sessions = new Map();
  const st = { title: '', url: 'about:blank' };
  sessions.set('TID', st);
  assert.equal(applyTargetInfoChanged(sessions, {
    targetInfo: { targetId: 'TID', title: 'Example Domain', url: 'https://example.com/' },
  }), true);
  assert.equal(st.title, 'Example Domain');
  assert.equal(st.url, 'https://example.com/');
  assert.equal(applyTargetInfoChanged(sessions, { targetInfo: { targetId: 'OTHER', title: 'x' } }), false);
});

test('wantsDocumentTitleRefresh after load and main-frame navigation, not on documentTitleChanged', () => {
  assert.equal(wantsDocumentTitleRefresh('Page.loadEventFired', {}), true);
  assert.equal(wantsDocumentTitleRefresh('Page.domContentEventFired', {}), true);
  assert.equal(wantsDocumentTitleRefresh('Page.frameNavigated', { frame: { id: 'f', parentId: null } }), true);
  assert.equal(wantsDocumentTitleRefresh('Page.frameNavigated', { frame: { id: 'c', parentId: 'f' } }), false);
  assert.equal(wantsDocumentTitleRefresh('Page.documentTitleChanged', { title: 'nope' }), false);
});

test('page-ops no longer listens for the non-existent Page.documentTitleChanged', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../daemon/page-ops.js'), 'utf8');
  assert.equal(src.includes("case 'Page.documentTitleChanged'"), false);
  assert.equal(src.includes("Target.targetInfoChanged"), true);
  assert.equal(src.includes('_refreshDocumentTitle'), true);
});
