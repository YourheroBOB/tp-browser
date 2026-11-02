// 回收計畫 × Store 作用中分頁／標籤序號的邊界。
// 執行：node --test tests/test_fmb_reaper_active_target.test.mjs
// 只用 os.tmpdir() 暫存 ledger，不連線、不讀寫使用者資料目錄。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import {
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from '../fmb_feature2/reaper.js';
import { buildPlan } from '../fmb_feature2/cli.js';

const NOW_ISO = '2026-06-01T00:00:00.000Z';
const OLD_ISO = '2020-01-01T00:00:00.000Z';
const NOW = Date.parse(NOW_ISO);

function ledgerPage(targetId, title = '', url = '') {
  return { targetId, openedBy: 'agent', title, url };
}

function withLedger(data, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-active-'));
  const file = join(dir, 'ledger.json');
  try {
    writeFileSync(file, JSON.stringify(data, null, 1));
    const store = new Store(file);
    return fn({
      file,
      store,
      disk() {
        return JSON.parse(readFileSync(file, 'utf8'));
      },
      raw() {
        return readFileSync(file, 'utf8');
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withFreshStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-active-'));
  const file = join(dir, 'ledger.json');
  try {
    const store = new Store(file);
    return fn({
      file,
      store,
      disk() {
        return JSON.parse(readFileSync(file, 'utf8'));
      },
      raw() {
        return readFileSync(file, 'utf8');
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('classifySpace / pageEntries / toTargetSet', () => {
  test('pageEntries keeps only plain pages and only non-empty string target ids', () => {
    const entries = pageEntries({
      pages: {
        p1: { targetId: 15 },
        p2: { targetId: '' },
        p3: { targetId: 'T-OK' },
        p4: null,
        p5: ['T-OK'],
        p6: 'T-OK',
        p7: { targetId: '   ' },
        p8: {},
      },
    });
    assert.deepEqual(entries.map((entry) => [entry.label, entry.targetId]), [
      ['p1', null],
      ['p2', null],
      ['p3', 'T-OK'],
      ['p7', '   '],
      ['p8', null],
    ]);
    assert.equal(pageEntries(null).length, 0);
    assert.equal(pageEntries({ pages: null }).length, 0);
    assert.equal(pageEntries({ pages: [{ targetId: 'T-DEAD' }] }).length, 0);
  });

  test('live target ids are a set of non-empty strings and nothing else', () => {
    const ids = toTargetSet(['T-LIVE', '', 1, null, 'T-LIVE', 'T-DEAD']);
    assert.equal(ids.size, 2);
    assert.equal(ids.has('T-LIVE'), true);
    assert.equal(ids.has('T-DEAD'), true);
    assert.equal(toTargetSet(new Set(['T-LIVE', ''])).size, 1);
    assert.equal(toTargetSet('T-LIVE').size, 0);
    assert.equal(toTargetSet({ 0: 'T-LIVE' }).size, 0);
    assert.equal(toTargetSet(undefined).size, 0);
  });

  test('kind follows live, then dead, unbound, mixed, empty', () => {
    const live = ['T-LIVE'];
    const kindOf = (pages) => classifySpace(
      { id: 1, createdAt: NOW_ISO, pages },
      { liveTargets: live, now: NOW },
    ).kind;
    assert.equal(kindOf({ p1: { targetId: 'T-LIVE' } }), 'live');
    assert.equal(kindOf({ p1: { targetId: 'T-DEAD' } }), 'dead');
    assert.equal(kindOf({ p1: { targetId: null } }), 'unbound');
    assert.equal(kindOf({ p1: { targetId: 'T-DEAD' }, p2: { targetId: null } }), 'mixed');
    assert.equal(kindOf({}), 'empty');
    assert.equal(kindOf({ p1: null, p2: 'x' }), 'empty');
    const mixedLive = classifySpace(
      { id: 1, createdAt: NOW_ISO, pages: { p1: { targetId: 'T-LIVE' }, p2: { targetId: 'T-DEAD' } } },
      { liveTargets: live, now: NOW },
    );
    assert.equal(mixedLive.kind, 'live');
    assert.equal(mixedLive.livePages.length, 1);
    assert.equal(mixedLive.deadPages.length, 1);
  });

  test('blank and numeric target ids are not live matches', () => {
    const blank = classifySpace(
      { createdAt: NOW, pages: { p1: { targetId: '' } } },
      { liveTargets: [''], now: NOW },
    );
    assert.equal(blank.kind, 'unbound');
    assert.equal(blank.livePages.length, 0);

    const numeric = classifySpace(
      { createdAt: NOW, pages: { p1: { targetId: 15 } } },
      { liveTargets: ['15', 15], now: NOW },
    );
    assert.equal(numeric.kind, 'unbound');

    const whitespace = classifySpace(
      { createdAt: NOW, pages: { p1: { targetId: '   ' } } },
      { liveTargets: ['T-LIVE'], now: NOW },
    );
    assert.equal(whitespace.kind, 'dead');
  });

  test('idle is age >= idleSpaceMs, future age clamps to 0, bad timestamps stay unknown', () => {
    const space = { id: 1, createdAt: 1_000_000, pages: { p1: { targetId: null } } };
    const almost = classifySpace(space, {
      liveTargets: ['T-LIVE'],
      now: 1_005_000 - 1,
      policy: { idleSpaceMs: 5_000 },
    });
    assert.equal(almost.ageMs, 4_999);
    assert.equal(almost.idle, false);
    const exact = classifySpace(space, {
      liveTargets: ['T-LIVE'],
      now: 1_005_000,
      policy: { idleSpaceMs: 5_000 },
    });
    assert.equal(exact.ageMs, 5_000);
    assert.equal(exact.idle, true);

    const future = classifySpace(
      { id: 1, createdAt: 5_000, pages: {} },
      { liveTargets: [], now: 1_000 },
    );
    assert.equal(future.ageMs, 0);
    assert.equal(future.kind, 'empty');
    assert.equal(future.idle, false);

    const unreadable = classifySpace(
      { id: 1, createdAt: 'not-a-date', pages: { p1: { targetId: null } } },
      { liveTargets: ['T-LIVE'], now: NOW, policy: { idleSpaceMs: 0 } },
    );
    assert.equal(unreadable.ageMs, null);
    assert.equal(unreadable.idle, false);
  });
});

describe('planReap policy', () => {
  test('id 0 is a real space; missing ids are skipped and counted', () => {
    const plan = planReap({
      spaces: [
        { id: 0, createdAt: NOW, pages: { p1: { targetId: 'T-DEAD' } } },
        { name: 'no-id', pages: { p1: { targetId: 'T-DEAD' } } },
        { id: null, pages: { p1: { targetId: 'T-DEAD' } } },
      ],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { idleSpaceMs: 60_000 },
    });
    assert.deepEqual(plan.closeSpaces, [0]);
    assert.equal(plan.stats.examined, 1);
    assert.equal(plan.stats.skipped, 2);
  });

  test('numeric ids sort before createdAt; non-numeric ids fall back to name', () => {
    const byId = planReap({
      spaces: [
        { id: 10, createdAt: OLD_ISO, pages: { p1: { targetId: 'T-DEAD' } } },
        { id: 2, createdAt: NOW_ISO, pages: { p1: { targetId: 'T-DEAD' } } },
      ],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
    });
    assert.deepEqual(byId.closeSpaces, [2, 10]);

    const byName = planReap({
      spaces: [
        { id: 'b', name: 'zeta', createdAt: NOW_ISO, pages: { p1: { targetId: 'T-DEAD' } } },
        { id: 'a', name: 'alpha', createdAt: NOW_ISO, pages: { p1: { targetId: 'T-DEAD' } } },
      ],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
    });
    assert.deepEqual(byName.closeSpaces, ['a', 'b']);
  });

  test('a bare string or a numeric live list does not open the safety valve', () => {
    const fromString = planReap({
      spaces: [{ id: 1, createdAt: OLD_ISO, pages: { p1: { targetId: 'NO' } } }],
      liveTargetIds: 'NO',
      now: NOW,
    });
    assert.equal(fromString.reason, 'no-live-targets');
    assert.deepEqual(fromString.closeSpaces, []);

    const fromNumbers = planReap({
      spaces: [{ id: 1, createdAt: OLD_ISO, pages: { p1: { targetId: 'T-GONE' } } }],
      liveTargetIds: [1, 2, 3],
      now: NOW,
    });
    assert.equal(fromNumbers.reason, 'no-live-targets');
    assert.deepEqual(fromNumbers.closeSpaces, []);
    assert.equal(fromNumbers.stats.examined, 1);
    assert.equal(fromNumbers.stats.closed, 0);
  });

  test('empty live set is a no-op unless the offline override is explicit', () => {
    const spaces = [
      { id: 1, createdAt: NOW_ISO, pages: { p1: { targetId: 'T-LIVE' } } },
      { id: 2, createdAt: NOW_ISO, pages: { p1: { targetId: null } } },
    ];
    const blocked = planReap({ spaces, liveTargetIds: [], now: NOW });
    assert.equal(blocked.reason, 'no-live-targets');
    assert.deepEqual(blocked.closeSpaces, []);
    assert.equal(blocked.stats.examined, 2);
    assert.equal(blocked.stats.skipped, 0);

    const forced = planReap({
      spaces,
      liveTargetIds: [],
      now: NOW,
      policy: { reapIdleWhenNoLiveTargets: true },
    });
    assert.equal(forced.reason, undefined);
    assert.deepEqual(forced.closeSpaces, [1]);
    assert.deepEqual(forced.dropPages, []);
    assert.equal(forced.stats.closed, 1);
  });

  test('reapDeadSpaces false still idle-closes old dead spaces, and only shells a young one', () => {
    const young = planReap({
      spaces: [{ id: 1, createdAt: NOW, pages: { p1: { targetId: 'T-GONE' }, p2: { targetId: null } } }],
      liveTargetIds: ['T-OTHER'],
      now: NOW,
      policy: { reapDeadSpaces: false },
    });
    // Young but every bound page is dead → mixed, not closed; only the dead page is dropped.
    assert.equal(classifySpace(
      { createdAt: NOW, pages: { p1: { targetId: 'T-GONE' }, p2: { targetId: null } } },
      { liveTargets: ['T-OTHER'], now: NOW },
    ).kind, 'mixed');
    assert.deepEqual(young.closeSpaces, []);
    assert.deepEqual(young.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'T-GONE' }]);

    const youngAllDead = planReap({
      spaces: [{ id: 1, createdAt: NOW, pages: { p1: { targetId: 'T-GONE' } } }],
      liveTargetIds: ['T-OTHER'],
      now: NOW,
      policy: { reapDeadSpaces: false },
    });
    assert.deepEqual(youngAllDead.closeSpaces, []);
    assert.deepEqual(youngAllDead.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'T-GONE' }]);

    const old = planReap({
      spaces: [{ id: 4, createdAt: 0, pages: { p1: { targetId: 'T-GONE' } } }],
      liveTargetIds: ['T-OTHER'],
      now: NOW,
      policy: { reapDeadSpaces: false },
    });
    assert.deepEqual(old.closeSpaces, [4]);
    assert.deepEqual(old.dropPages, []);
  });

  test('idleSpaceMs null disables idle, 0 means immediately idle, undefined keeps the default', () => {
    const oldUnbound = { id: 1, createdAt: 0, pages: { p1: { targetId: null } } };
    const disabled = planReap({
      spaces: [oldUnbound],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { idleSpaceMs: null },
    });
    assert.deepEqual(disabled.closeSpaces, []);

    const immediate = planReap({
      spaces: [{ id: 1, createdAt: NOW, pages: { p1: { targetId: null } } }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { idleSpaceMs: 0 },
    });
    assert.deepEqual(immediate.closeSpaces, [1]);

    const unreadable = planReap({
      spaces: [{ id: 1, createdAt: 'not-a-date', pages: { p1: { targetId: null } } }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { idleSpaceMs: 0 },
    });
    assert.deepEqual(unreadable.closeSpaces, []);

    const defaults = planReap({
      spaces: [oldUnbound],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { idleSpaceMs: undefined, maxSpaces: undefined },
    });
    assert.deepEqual(defaults.closeSpaces, [1]);
  });

  test('maxSpaces never closes a live space, even when the cap is zero', () => {
    const onlyLive = planReap({
      spaces: [{ id: 7, name: 'alive', createdAt: OLD_ISO, pages: { p1: { targetId: 'T-LIVE' } } }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { maxSpaces: 0 },
    });
    assert.deepEqual(onlyLive.closeSpaces, []);
    assert.equal(onlyLive.stats.overCap, 0);
    assert.equal(onlyLive.stats.live, 1);

    const capped = planReap({
      spaces: [
        { id: 1, createdAt: NOW_ISO, pages: { p1: { targetId: null } } },
        { id: 2, createdAt: NOW_ISO, pages: { p1: { targetId: null } } },
        { id: 3, createdAt: NOW_ISO, pages: { p1: { targetId: null } } },
        { id: 10, createdAt: OLD_ISO, pages: { p1: { targetId: 'T-LIVE' } } },
      ],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      policy: { maxSpaces: 2 },
    });
    assert.deepEqual(capped.closeSpaces, [1, 2]);
    assert.equal(capped.stats.overCap, 2);
    assert.equal(capped.stats.live, 1);
  });

  test('only boolean true pins; protect ids are stringified; pinned pages are not dropped', () => {
    const stringPin = planReap({
      spaces: [{ id: 1, pinned: 'true', createdAt: NOW, pages: { p1: { targetId: 'T-DEAD' } } }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
    });
    assert.deepEqual(stringPin.closeSpaces, [1]);

    const realPin = planReap({
      spaces: [{
        id: 1,
        pinned: true,
        createdAt: OLD_ISO,
        activeTargetId: 'T-DEAD',
        pages: { p1: { targetId: 'T-LIVE' }, p2: { targetId: 'T-DEAD' } },
      }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
    });
    assert.deepEqual(realPin.closeSpaces, []);
    assert.deepEqual(realPin.dropPages, []);
    assert.deepEqual(realPin.staleActiveTargets, []);
    assert.equal(realPin.stats.protected, 1);
    assert.equal(realPin.stats.live, 0);

    const protectedId = planReap({
      spaces: [{ id: '6', createdAt: OLD_ISO, pages: { p1: { targetId: 'T-DEAD' } } }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
      protect: [6],
    });
    assert.deepEqual(protectedId.closeSpaces, []);
    assert.equal(protectedId.stats.protected, 1);
  });

  test('a live space drops dead pages only; a fully dead space is closed instead', () => {
    const mixed = planReap({
      spaces: [{
        id: 1,
        createdAt: NOW,
        pages: { p1: { targetId: 'T-DEAD' }, p2: { targetId: null } },
      }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
    });
    assert.deepEqual(mixed.closeSpaces, []);
    assert.deepEqual(mixed.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'T-DEAD' }]);

    const dead = planReap({
      spaces: [{
        id: 1,
        createdAt: NOW,
        pages: { p1: { targetId: 'T-A' }, p9: { targetId: 'T-B' } },
      }],
      liveTargetIds: ['T-LIVE'],
      now: NOW,
    });
    assert.deepEqual(dead.closeSpaces, [1]);
    assert.deepEqual(dead.dropPages, []);
  });

  test('invalid input and a non-array live list are non-destructive and do not mutate callers', () => {
    const spaces = [{
      id: 1,
      createdAt: OLD_ISO,
      activeTargetId: 'T-DEAD',
      pages: { p1: { targetId: 'T-DEAD', title: 'x' } },
    }];
    const snapshot = structuredClone(spaces);
    const plan = planReap({ spaces, liveTargetIds: ['T-LIVE'], now: NOW });
    assert.deepEqual(spaces, snapshot);
    assert.deepEqual(plan.closeSpaces, [1]);

    const invalid = planReap({ spaces: null, liveTargetIds: ['T-LIVE'] });
    assert.equal(invalid.reason, 'invalid-input');
    assert.deepEqual(invalid.closeSpaces, []);
    assert.deepEqual(invalid.stats, {
      examined: 0,
      skipped: 0,
      live: 0,
      protected: 0,
      closed: 0,
      pagesDropped: 0,
      staleActiveTargets: 0,
      overCap: 0,
    });

    const omitted = planReap({ liveTargetIds: ['T-LIVE'] });
    assert.equal(omitted.reason, 'invalid-input');

    const counted = planReap({
      spaces: [{ id: 1, pages: {} }, null, 5],
      liveTargetIds: [],
    });
    assert.equal(counted.reason, 'no-live-targets');
    assert.equal(counted.stats.examined, 1);
    assert.equal(counted.stats.skipped, 2);
  });
});

describe('applyReapPlan and buildPlan', () => {
  test('applyReapPlan drops only surviving pages and ignores missing store methods', () => {
    assert.deepEqual(applyReapPlan(), { closedSpaces: [], droppedPages: [] });
    assert.deepEqual(applyReapPlan(null, null), { closedSpaces: [], droppedPages: [] });
    assert.deepEqual(
      applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p1' }] }),
      { closedSpaces: [], droppedPages: [] },
    );

    const calls = [];
    const out = applyReapPlan({
      deleteSpace(id) { calls.push(['del', id]); },
      removePage(id, label) { calls.push(['rm', id, label]); },
    }, {
      closeSpaces: [1, 1],
      dropPages: [
        { spaceId: 1, label: 'p2', targetId: 'T' },
        { spaceId: '1', label: 'p3' },
        { spaceId: 2, label: 'p9', targetId: 'U' },
        { spaceId: 2, label: null },
        { spaceId: 2 },
        null,
        { spaceId: 3, label: 0 },
      ],
    });
    assert.deepEqual(calls, [
      ['del', 1],
      ['del', 1],
      ['rm', 2, 'p9'],
      ['rm', 3, 0],
    ]);
    assert.deepEqual(out.closedSpaces, [1, 1]);
    assert.deepEqual(out.droppedPages, [
      { spaceId: 2, label: 'p9', targetId: 'U' },
      { spaceId: 3, label: 0 },
    ]);

    const dropped = [];
    const partial = applyReapPlan(
      { removePage(id, label) { dropped.push([id, label]); } },
      { closeSpaces: [1], dropPages: [{ spaceId: 1, label: 'p1' }, { spaceId: 2, label: 'p2' }] },
    );
    assert.deepEqual(dropped, [[2, 'p2']]);
    assert.deepEqual(partial.closedSpaces, []);
  });

  test('buildPlan rejects non-objects, defaults null fields, and does not treat null now as zero', () => {
    assert.throws(() => buildPlan('not json'), /invalid JSON input/);
    assert.throws(() => buildPlan(''), /invalid JSON input/);
    assert.throws(() => buildPlan('[]'), /payload must be a JSON object/);
    assert.throws(() => buildPlan('null'), /payload must be a JSON object/);
    assert.throws(() => buildPlan('"x"'), /payload must be a JSON object/);

    const emptied = buildPlan('{"liveTargetIds":["T-LIVE"],"spaces":null,"protect":null,"policy":null}');
    assert.equal(emptied.reason, undefined);
    assert.deepEqual(emptied.closeSpaces, []);
    assert.equal(emptied.stats.examined, 0);

    const valve = buildPlan('{"spaces":[],"liveTargetIds":null}');
    assert.equal(valve.reason, 'no-live-targets');

    const kept = buildPlan(JSON.stringify({
      now: 0,
      liveTargetIds: ['T-LIVE'],
      spaces: [
        { id: 1, createdAt: '1970-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-LIVE' } } },
        { id: 2, createdAt: '2999-01-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
      ],
    }));
    assert.deepEqual(kept.closeSpaces, []);

    const closed = buildPlan(JSON.stringify({
      now: null,
      liveTargetIds: ['T-LIVE'],
      spaces: [
        { id: 1, createdAt: NOW_ISO, pages: { p1: { targetId: 'T-LIVE' } } },
        { id: 2, createdAt: '1970-01-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
      ],
    }));
    assert.deepEqual(closed.closeSpaces, [2]);

    const shelled = buildPlan(JSON.stringify({
      now: 0,
      liveTargetIds: ['T-LIVE'],
      policy: { reapDeadSpaces: false },
      spaces: [
        { id: 1, createdAt: '2999-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-DEAD' } } },
        { id: 2, createdAt: '1970-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-LIVE' } } },
      ],
    }));
    assert.deepEqual(shelled.closeSpaces, []);
    assert.deepEqual(shelled.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'T-DEAD' }]);
  });
});

describe('Store activeTargetId and labelSeq', () => {
  test('nextLabel on an empty store does not create a ledger file', () => {
    withFreshStore(({ store, file }) => {
      assert.equal(store.nextLabel(1), 'p?');
      assert.equal(store.list().length, 0);
      assert.equal(existsSync(file), false);
    });
  });

  test('nextLabel does not recycle a removed label, and a miss does not persist', () => {
    withFreshStore(({ store, raw, disk }) => {
      const space = store.create({ name: 'hole' });
      assert.equal(space.profileId, 'agent');
      assert.equal(store.nextLabel(space.id), 'p2');
      store.bindPage(space.id, 'p2', 'T-B');
      assert.equal(store.nextLabel(space.id), 'p3');
      store.removePage(space.id, 'p2');
      assert.equal(store.nextLabel(space.id), 'p4');
      assert.deepEqual(Object.keys(store.get(space.id).pages), ['p1']);
      assert.equal(disk().labelSeq['1'], 4);
      const before = raw();
      assert.equal(store.nextLabel(999), 'p?');
      assert.throws(() => store.bindPage(999, 'p1', 'T-X'), /unknown space 999/);
      assert.equal(raw(), before);
    });
  });

  test('removePage clears activeTargetId only when the removed page owns that exact id', () => {
    withLedger({
      nextSpaceId: 2,
      labelSeq: { 1: 4 },
      spaces: {
        1: {
          id: 1,
          name: 's',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-A',
          pages: {
            p1: ledgerPage('T-A', 'a', 'http://127.0.0.1/a'),
            p2: ledgerPage('T-B', 'b', 'http://127.0.0.1/b'),
            p3: ledgerPage(null, 'placeholder', ''),
            p4: ledgerPage('T-A ', 'near', 'http://127.0.0.1/near'),
          },
        },
      },
    }, ({ store, file }) => {
      assert.equal(store.get(1), store.get('1'));
      store.removePage(1, 'p4');
      assert.equal(store.get(1).activeTargetId, 'T-A');
      store.removePage(1, 'p3');
      assert.equal(store.get(1).activeTargetId, 'T-A');
      store.removePage(1, 'p2');
      assert.equal(store.get(1).activeTargetId, 'T-A');
      assert.equal(store.get(1).pages.p1.targetId, 'T-A');
      store.removePage(1, 'p1');
      assert.equal(store.get(1).activeTargetId, null);
      assert.equal(store.get(1).pages.p1, undefined);
      const reloaded = new Store(file);
      assert.equal(reloaded.get(1).activeTargetId, null);
      assert.equal(reloaded.get(1).pages.p2, undefined);
      assert.equal(reloaded.list().length, 1);
    });
  });

  test('removePage of an unknown space or label does not rewrite the ledger', () => {
    withLedger({
      nextSpaceId: 2,
      labelSeq: { 1: 2 },
      spaces: {
        1: {
          id: 1,
          name: 's',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-A',
          pages: {
            p1: ledgerPage('T-A', 'a', 'http://127.0.0.1/a'),
            p2: ledgerPage('T-B', 'b', 'http://127.0.0.1/b'),
          },
        },
      },
    }, ({ store, raw }) => {
      const before = raw();
      store.removePage(1, 'missing');
      store.removePage(42, 'p1');
      store.removePage(1, 'toString');
      assert.equal(raw(), before);
      assert.equal(store.get(1).activeTargetId, 'T-A');
      assert.equal(store.get(1).pages.p2.targetId, 'T-B');
    });
  });

  test('removing the last page keeps the space and its labelSeq', () => {
    withLedger({
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: {
          id: 1,
          name: 'last',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-A',
          pages: { p1: ledgerPage('T-A', 'only', 'http://127.0.0.1/only') },
        },
      },
    }, ({ store, disk }) => {
      store.removePage(1, 'p1');
      const saved = disk();
      assert.equal(saved.nextSpaceId, 2);
      assert.equal(saved.labelSeq['1'], 1);
      assert.equal(saved.spaces['1'].name, 'last');
      assert.equal(saved.spaces['1'].activeTargetId, null);
      assert.deepEqual(saved.spaces['1'].pages, {});
      assert.equal(store.get(1).state, 'active');
    });
  });

  test('deleteSpace clears that labelSeq, including an orphan, and does not rewind ids', () => {
    withLedger({
      nextSpaceId: 5,
      labelSeq: { 1: 1, 2: 3, 99: 4 },
      spaces: {
        1: {
          id: 1,
          name: 'keep',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: null,
          pages: { p1: ledgerPage(null, 'keep', 'http://127.0.0.1/keep') },
        },
        2: {
          id: 2,
          name: 'drop',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-X',
          pages: { p1: ledgerPage('T-X', 'drop', 'http://127.0.0.1/drop') },
        },
      },
    }, ({ store, disk }) => {
      store.deleteSpace(2);
      let saved = disk();
      assert.equal(saved.spaces['2'], undefined);
      assert.equal(saved.labelSeq['2'], undefined);
      assert.equal(saved.labelSeq['1'], 1);
      assert.equal(saved.labelSeq['99'], 4);
      assert.equal(saved.nextSpaceId, 5);
      assert.equal(saved.spaces['1'].pages.p1.title, 'keep');

      store.deleteSpace(99);
      const afterOrphan = disk();
      assert.equal(afterOrphan.labelSeq['99'], undefined);
      assert.equal(afterOrphan.spaces['1'].name, 'keep');
      store.deleteSpace(99);
      assert.deepEqual(disk(), afterOrphan);

      const created = store.create({ name: 'next' });
      assert.equal(created.id, 5);
      saved = disk();
      assert.equal(saved.nextSpaceId, 6);
      assert.equal(saved.spaces['5'].name, 'next');
      assert.equal(saved.spaces['5'].profileId, 'agent');
      assert.equal(saved.spaces['1'].name, 'keep');
      assert.equal(saved.spaces['2'], undefined);
      assert.equal(saved.labelSeq['5'], 1);
      assert.equal(saved.labelSeq['1'], 1);
    });
  });
});

describe('planReap applied through Store', () => {
  function integrationLedger() {
    return {
      nextSpaceId: 7,
      labelSeq: { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 99: 8 },
      spaces: {
        1: {
          id: 1,
          name: 'mixed',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: OLD_ISO,
          activeTargetId: 'T-DEAD',
          pages: {
            p1: ledgerPage('T-LIVE', 'keep-title', 'http://127.0.0.1/keep'),
            p2: ledgerPage('T-DEAD', 'drop-title', 'http://127.0.0.1/drop'),
          },
        },
        2: {
          id: 2,
          name: 'dead-recent',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-GONE',
          pages: { p1: ledgerPage('T-GONE', 'gone', 'http://127.0.0.1/gone') },
        },
        3: {
          id: 3,
          name: 'unbound-old',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: OLD_ISO,
          activeTargetId: null,
          pages: { p1: ledgerPage(null) },
        },
        4: {
          id: 4,
          name: 'unbound-young',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-STALE',
          pages: { p1: ledgerPage(null, 'young', 'http://127.0.0.1/young') },
        },
        5: {
          id: 5,
          name: 'pinned-dead',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          pinned: true,
          createdAt: OLD_ISO,
          activeTargetId: 'T-PIN',
          pages: { p1: ledgerPage('T-PIN', 'pin', 'http://127.0.0.1/pin') },
        },
        6: {
          id: 6,
          name: 'protected-dead',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: OLD_ISO,
          activeTargetId: 'T-PROT',
          pages: { p1: ledgerPage('T-PROT', 'prot', 'http://127.0.0.1/prot') },
        },
      },
    };
  }

  test('dropping the active dead page clears it; closing a space clears labelSeq; stale survivors stay', () => {
    withLedger(integrationLedger(), ({ store, file, disk }) => {
      const plan = planReap({
        spaces: store.list(),
        liveTargetIds: ['T-LIVE'],
        now: NOW,
        protect: [6],
        policy: { maxSpaces: 50 },
      });
      assert.deepEqual(plan.closeSpaces, [2, 3]);
      assert.deepEqual(plan.dropPages, [{ spaceId: 1, label: 'p2', targetId: 'T-DEAD' }]);
      assert.deepEqual(plan.staleActiveTargets, [
        { spaceId: 1, targetId: 'T-DEAD' },
        { spaceId: 4, targetId: 'T-STALE' },
      ]);
      assert.deepEqual(plan.stats, {
        examined: 6,
        skipped: 0,
        live: 1,
        protected: 2,
        closed: 2,
        pagesDropped: 1,
        staleActiveTargets: 2,
        overCap: 0,
      });

      applyReapPlan(store, plan);
      const reloaded = new Store(file);
      assert.deepEqual(reloaded.get(1), {
        id: 1,
        name: 'mixed',
        profileId: 'agent',
        ownership: 'agent',
        state: 'active',
        createdAt: OLD_ISO,
        activeTargetId: null,
        pages: {
          p1: ledgerPage('T-LIVE', 'keep-title', 'http://127.0.0.1/keep'),
        },
      });
      assert.equal(reloaded.get(2), null);
      assert.equal(reloaded.get(3), null);
      assert.equal(reloaded.get(4).activeTargetId, 'T-STALE');
      assert.equal(reloaded.get(4).pages.p1.title, 'young');
      assert.equal(reloaded.get(5).pinned, true);
      assert.equal(reloaded.get(5).activeTargetId, 'T-PIN');
      assert.equal(reloaded.get(5).pages.p1.targetId, 'T-PIN');
      assert.equal(reloaded.get(6).activeTargetId, 'T-PROT');
      assert.equal(reloaded.get(6).pages.p1.targetId, 'T-PROT');
      assert.equal(reloaded.disk ? undefined : disk().nextSpaceId, 7);
      const saved = disk();
      assert.equal(saved.nextSpaceId, 7);
      assert.deepEqual(saved.labelSeq, { 1: 2, 4: 1, 5: 1, 6: 1, 99: 8 });

      const after = disk();
      applyReapPlan(store, plan);
      assert.deepEqual(disk(), after);

      const blocked = planReap({ spaces: store.list(), liveTargetIds: [], now: NOW });
      assert.equal(blocked.reason, 'no-live-targets');
      applyReapPlan(store, blocked);
      assert.deepEqual(disk(), after);

      const again = planReap({
        spaces: store.list(),
        liveTargetIds: ['T-LIVE'],
        now: NOW,
        protect: [6],
      });
      assert.deepEqual(again.closeSpaces, []);
      assert.deepEqual(again.dropPages, []);
      assert.deepEqual(again.staleActiveTargets, [{ spaceId: 4, targetId: 'T-STALE' }]);
      applyReapPlan(store, again);
      assert.deepEqual(disk(), after);
    });
  });

  test('dropDeadPages false leaves the stale active target on the kept page', () => {
    withLedger({
      nextSpaceId: 2,
      labelSeq: { 1: 2 },
      spaces: {
        1: {
          id: 1,
          name: 'mixed',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-DEAD',
          pages: {
            p1: ledgerPage('T-LIVE', 'keep', 'http://127.0.0.1/keep'),
            p2: ledgerPage('T-DEAD', 'stay', 'http://127.0.0.1/stay'),
          },
        },
      },
    }, ({ store, disk }) => {
      const plan = planReap({
        spaces: store.list(),
        liveTargetIds: ['T-LIVE'],
        now: NOW,
        policy: { dropDeadPages: false },
      });
      assert.deepEqual(plan.dropPages, []);
      assert.deepEqual(plan.staleActiveTargets, [{ spaceId: 1, targetId: 'T-DEAD' }]);
      const before = disk();
      applyReapPlan(store, plan);
      assert.deepEqual(disk(), before);
      assert.equal(store.get(1).pages.p2.targetId, 'T-DEAD');
      assert.equal(store.get(1).activeTargetId, 'T-DEAD');
    });
  });

  test('a young dead space with reapDeadSpaces false becomes an empty shell and clears activeTargetId', () => {
    withLedger({
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: {
          id: 1,
          name: 'dead',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: NOW_ISO,
          activeTargetId: 'T-GONE',
          pages: { p1: ledgerPage('T-GONE', 'gone', 'http://127.0.0.1/gone') },
        },
      },
    }, ({ store, disk }) => {
      const plan = planReap({
        spaces: store.list(),
        liveTargetIds: ['T-OTHER'],
        now: NOW,
        policy: { reapDeadSpaces: false, maxSpaces: 50 },
      });
      assert.deepEqual(plan.closeSpaces, []);
      assert.deepEqual(plan.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'T-GONE' }]);
      applyReapPlan(store, plan);
      const saved = disk();
      assert.equal(saved.nextSpaceId, 2);
      assert.equal(saved.labelSeq['1'], 1);
      assert.equal(saved.spaces['1'].name, 'dead');
      assert.equal(saved.spaces['1'].activeTargetId, null);
      assert.deepEqual(saved.spaces['1'].pages, {});
    });
  });
});

describe('known ledger shape gap', () => {
  test('a ledger without a plain spaces object still accepts list/create', {
    todo: 'product bug: normalizeLedger repairs nextSpaceId and labelSeq but not spaces, so {} / null / array / string spaces still throw or persist a non-object',
  }, () => {
    const bodies = [
      {},
      { nextSpaceId: 4 },
      { spaces: null, nextSpaceId: 1, labelSeq: {} },
      { spaces: [], nextSpaceId: 1, labelSeq: {} },
      { spaces: 'x', nextSpaceId: 1, labelSeq: {} },
    ];
    for (const [index, body] of bodies.entries()) {
      withLedger(body, ({ store, disk }) => {
        assert.equal(store.get(1), null);
        assert.deepEqual(store.list(), []);
        const space = store.create({ name: `recovered-${index}` });
        assert.equal(Number.isInteger(space.id) && space.id >= 1, true);
        if (body.nextSpaceId === 4) assert.equal(space.id, 4);
        const saved = disk();
        assert.equal(saved.spaces !== null && typeof saved.spaces === 'object' && !Array.isArray(saved.spaces), true);
        assert.equal(saved.spaces[String(space.id)].name, `recovered-${index}`);
        assert.equal(saved.labelSeq[String(space.id)], 1);
      });
    }
  });
});
