import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadDaemon(home) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const daemonDir = join(repoRoot, 'daemon');
  const href = (name) => JSON.stringify(pathToFileURL(join(daemonDir, name)).href);
  let src = readFileSync(join(daemonDir, 'tp-browserd.js'), 'utf8');
  src = src.replace("import { BrowserHub, EgoError } from './page-ops.js';\n", '');
  src = src.replace("import { Cdp } from './cdp.js';", `import { Cdp } from ${href('cdp.js')};`);
  src = src.replace("import { Store } from './store.js';", `import { Store } from ${href('store.js')};`);
  src = src.replace(
    "import { keyDescriptor } from './keys.js';",
    `import { keyDescriptor } from ${href('keys.js')};\nclass EgoError extends Error { constructor(name, message) { super(message); this.name = name; } }\nclass BrowserHub {}`,
  );
  const marker = 'process.exit(0); });';
  const start = src.indexOf("server.listen(PORT, '127.0.0.1'");
  const end = src.indexOf(marker);
  if (start < 0 || end < start) throw new Error('could not locate daemon startup');
  src = src.slice(0, start) + src.slice(end + marker.length);
  if (src.includes('server.listen(') || src.includes('attachChrome();') || src.includes("from './")) {
    throw new Error('harness left startup side effects or relative imports in place');
  }
  src += `
export function __installHub(fake) { hub = fake; chromeReady = true; }
export function __getStore() { return store; }
export function __dispatch(method, params) { return dispatch(method, params); }
`;
  const harness = join(home, 'tp-browserd-harness.mjs');
  writeFileSync(harness, src);
  return import(pathToFileURL(harness).href);
}

test('page.adopt keeps a single owner for one target', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tpb-adopt-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await loadDaemon(home);
    mod.__installHub({
      sessions: new Map([
        ['TGT-1', { sessionId: 's1', url: 'https://example.test/', title: 'Example', isPopup: false }],
      ]),
      cdp: { async send() { throw new Error('unexpected cdp call'); } },
    });
    const store = mod.__getStore();
    const spaceA = store.create({ name: 'space-a' });
    const spaceB = store.create({ name: 'space-b' });

    const first = await mod.__dispatch('page.adopt', { spaceId: spaceA.id, targetId: 'TGT-1' });
    const second = await mod.__dispatch('page.adopt', { spaceId: spaceA.id, targetId: 'TGT-1', as: 'other' });
    assert.equal(second.label, first.label);
    assert.equal(second.targetId, 'TGT-1');
    const ownersA = Object.entries(store.get(spaceA.id).pages)
      .filter(([, pg]) => pg && pg.targetId === 'TGT-1');
    assert.equal(ownersA.length, 1);
    assert.equal(ownersA[0][0], first.label);

    await assert.rejects(
      () => mod.__dispatch('page.adopt', { spaceId: spaceB.id, targetId: 'TGT-1' }),
      (err) => {
        assert.equal(err.name, 'TargetInUse');
        assert.match(err.message, /TGT-1/);
        return true;
      },
    );
    const ownersB = Object.values(store.get(spaceB.id).pages)
      .filter((pg) => pg && pg.targetId === 'TGT-1');
    assert.equal(ownersB.length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
});
