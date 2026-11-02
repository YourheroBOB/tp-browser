// Boundary, coercion, and error-path tests for fmb_feature2/reaper.js.
// Does not repeat the happy-path matrix in fmb_feature2/reaper.test.js
// (basic classify / idle / safety valves / ordinary maxSpaces / sort / apply).
// No network. Temp files stay under os.tmpdir().
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../daemon/store.js';
import {
  DEFAULT_POLICY,
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const RECENT = '2026-06-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';
const FAR_IDLE = 1e15;

function unbound(id, createdAt = RECENT) {
  return { id, name: `u${id}`, createdAt, pages: { p1: { targetId: null } } };
}

function recorder() {
  const calls = [];
  return {
    calls,
    deleteSpace(id) { calls.push(['deleteSpace', id]); },
    removePage(spaceId, label) { calls.push(['removePage', spaceId, label]); },
  };
}

test('toTargetSet keeps only non-empty strings', () => {
  assert.deepEqual([...toTargetSet(new Set(['ok', '', 1, null, 'ok2']))], ['ok', 'ok2']);
  assert.deepEqual([...toTargetSet(['A', 'A', ''])], ['A']);
  assert.equal(toTargetSet('LIVE').size, 0);
  assert.equal(toTargetSet({ 0: 'LIVE' }).size, 0);
  assert.equal(toTargetSet(null).size, 0);
  assert.equal(toTargetSet(undefined).size, 0);
});

test('pageEntries ignores non-objects, empty ids, and inherited keys', () => {
  assert.deepEqual(pageEntries(undefined), []);
  assert.deepEqual(pageEntries(null), []);
  assert.deepEqual(pageEntries({ pages: null }), []);
  assert.deepEqual(pageEntries({ pages: [{ targetId: 'T' }] }), []);
  const proto = { inherited: { targetId: 'I' } };
  const pages = Object.create(proto);
  pages.own = { targetId: 'O' };
  pages.blank = { targetId: '' };
  pages.bad = null;
  assert.deepEqual(pageEntries({ pages }).map((e) => [e.label, e.targetId]), [
    ['own', 'O'],
    ['blank', null],
  ]);
});

test('classifySpace treats empty, numeric, and whitespace target ids by kind', () => {
  assert.equal(classifySpace(null).kind, 'empty');
  assert.equal(classifySpace({ pages: {} }).kind, 'empty');
  const bare = classifySpace({ pages: { p1: { targetId: 'T' } } });
  assert.equal(bare.kind, 'dead');
  assert.equal(bare.ageMs, null);
  assert.equal(bare.idle, false);

  const info = classifySpace({
    pages: {
      a: { targetId: 5 },
      b: { targetId: ' ' },
      c: { targetId: '' },
      d: { targetId: 'LIVE' },
    },
  }, { liveTargets: ['LIVE'], now: NOW });
  assert.equal(info.kind, 'live');
  assert.deepEqual(info.deadPages.map((e) => e.label), ['b']);
  assert.deepEqual(info.unboundPages.map((e) => e.label), ['a', 'c']);

  const invisible = classifySpace({
    createdAt: OLD,
    pages: { p1: null, p2: 1, p3: ['T'] },
  }, { liveTargets: ['L'], now: NOW });
  assert.equal(invisible.kind, 'empty');
  assert.equal(invisible.entries.length, 0);
  assert.equal(invisible.idle, true);
});

test('idle boundary is inclusive, and future timestamps clamp to age 0', () => {
  const base = { pages: { p1: { targetId: null } } };
  const at = classifySpace(
    { ...base, createdAt: NOW - 1000 },
    { liveTargets: ['KEEP'], now: NOW, policy: { idleSpaceMs: 1000 } },
  );
  assert.equal(at.ageMs, 1000);
  assert.equal(at.idle, true);
  assert.equal(at.kind, 'unbound');

  const under = classifySpace(
    { ...base, createdAt: NOW - 999 },
    { liveTargets: ['KEEP'], now: NOW, policy: { idleSpaceMs: 1000 } },
  );
  assert.equal(under.ageMs, 999);
  assert.equal(under.idle, false);

  const future = classifySpace(
    { ...base, createdAt: NOW + 5000 },
    { liveTargets: ['KEEP'], now: NOW, policy: { idleSpaceMs: 1000 } },
  );
  assert.equal(future.ageMs, 0);
  assert.equal(future.idle, false);

  const zeroPolicy = classifySpace(
    { ...base, createdAt: NOW + 5000 },
    { liveTargets: ['KEEP'], now: NOW, policy: { idleSpaceMs: 0 } },
  );
  assert.equal(zeroPolicy.ageMs, 0);
  assert.equal(zeroPolicy.idle, true);

  const unparsable = classifySpace(
    { ...base, createdAt: 'not-a-date' },
    { liveTargets: ['KEEP'], now: NOW, policy: { idleSpaceMs: 0 } },
  );
  assert.equal(unparsable.ageMs, null);
  assert.equal(unparsable.idle, false);
});

test('DEFAULT_POLICY is frozen and planReap does not mutate inputs', () => {
  assert.equal(DEFAULT_POLICY.maxSpaces, 50);
  assert.equal(DEFAULT_POLICY.idleSpaceMs, 30 * 60 * 1000);
  assert.throws(() => { DEFAULT_POLICY.maxSpaces = 1; }, TypeError);
  assert.equal(DEFAULT_POLICY.maxSpaces, 50);

  const spaces = [unbound(2), unbound(1)];
  const policy = { maxSpaces: 0, idleSpaceMs: FAR_IDLE };
  const beforeSpaces = JSON.stringify(spaces);
  const beforePolicy = JSON.stringify(policy);
  planReap({ spaces, liveTargetIds: ['L'], now: NOW, policy, protect: [1] });
  assert.equal(JSON.stringify(spaces), beforeSpaces);
  assert.equal(JSON.stringify(policy), beforePolicy);
  assert.equal(spaces[0].id, 2);
});

test('invalid spaces short-circuit; sparse arrays only skip bad rows', () => {
  const bad = planReap({ spaces: { length: 1 }, liveTargetIds: ['L'] });
  assert.equal(bad.reason, 'invalid-input');
  assert.equal(bad.stats.examined, 0);
  assert.equal(bad.stats.skipped, 0);
  assert.deepEqual(bad.closeSpaces, []);
  assert.equal(planReap().reason, 'invalid-input');

  const skipped = planReap({
    spaces: [null, 1, { name: 'no-id' }, { id: null }, { id: 1, name: 'ok', createdAt: RECENT, pages: {} }],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE, maxSpaces: 50 },
  });
  assert.equal('reason' in skipped, false);
  assert.equal(skipped.stats.skipped, 4);
  assert.equal(skipped.stats.examined, 1);
  assert.deepEqual(skipped.closeSpaces, []);
});

test('empty live ids and numeric-only ids trip the safety valve', () => {
  const oldDead = [{ id: 1, name: 'd', createdAt: OLD, pages: { p1: { targetId: 'GONE' } } }];
  for (const liveTargetIds of [[], new Set(), ['', ''], [5]]) {
    const plan = planReap({ spaces: oldDead, liveTargetIds, now: NOW });
    assert.equal(plan.reason, 'no-live-targets', JSON.stringify(liveTargetIds));
    assert.deepEqual(plan.closeSpaces, []);
  }
  const single = planReap({
    spaces: [{ id: 1, name: 'd', createdAt: OLD, pages: { p1: { targetId: 'Live' } } }],
    liveTargetIds: 'Live',
    now: NOW,
  });
  assert.equal(single.reason, 'no-live-targets');
  assert.deepEqual(single.closeSpaces, []);
});

test('target identity is case-sensitive and string-only once the valve is open', () => {
  const mixedCase = [{ id: 1, name: 'd', createdAt: RECENT, pages: { p1: { targetId: 'Live' } } }];
  assert.deepEqual(
    planReap({ spaces: mixedCase, liveTargetIds: ['LIVE'], now: NOW, policy: { idleSpaceMs: FAR_IDLE } }).closeSpaces,
    [1],
  );
  assert.deepEqual(
    planReap({ spaces: mixedCase, liveTargetIds: ['Live'], now: NOW, policy: { idleSpaceMs: FAR_IDLE } }).closeSpaces,
    [],
  );
  const num = [{ id: 1, name: 'd', createdAt: RECENT, pages: { p1: { targetId: '5' } } }];
  // 數字 5 會被 toTargetSet 丟掉。旁邊放一個真正的字串 id，空集合安全閥才會打開；
  // 打開之後 '5' 仍不等於數字 5，空間照 dead 回收。字串 '5' 則是同一個 target。
  assert.deepEqual(
    planReap({
      spaces: num,
      liveTargetIds: [5, 'OTHER'],
      now: NOW,
      policy: { idleSpaceMs: FAR_IDLE },
    }).closeSpaces,
    [1],
  );
  assert.deepEqual(
    planReap({ spaces: num, liveTargetIds: ['5'], now: NOW, policy: { idleSpaceMs: FAR_IDLE } }).closeSpaces,
    [],
  );
});

test('non-finite now falls back to Date.now so an old unbound space still idles', () => {
  const spaces = [{ id: 1, name: 'u', createdAt: OLD, pages: { p1: { targetId: null } } }];
  for (const now of [NaN, null, undefined, Infinity]) {
    const plan = planReap({ spaces, liveTargetIds: ['L'], now, policy: { maxSpaces: 100 } });
    assert.deepEqual(plan.closeSpaces, [1], String(now));
  }
});

test('idleSpaceMs and reap flags only honor real booleans and finite numbers', () => {
  const oldUnbound = [{ id: 1, name: 'u', createdAt: OLD, pages: { p1: { targetId: null } } }];
  assert.deepEqual(
    planReap({ spaces: oldUnbound, liveTargetIds: ['L'], now: NOW, policy: { idleSpaceMs: '0', maxSpaces: 50 } }).closeSpaces,
    [],
  );
  assert.deepEqual(
    planReap({ spaces: oldUnbound, liveTargetIds: ['L'], now: NOW, policy: { idleSpaceMs: 0, maxSpaces: 50 } }).closeSpaces,
    [1],
  );
  assert.deepEqual(
    planReap({
      spaces: oldUnbound,
      liveTargetIds: ['L'],
      now: NOW,
      policy: { idleSpaceMs: null, maxSpaces: 50 },
    }).closeSpaces,
    [],
  );

  const recentDead = [{ id: 1, name: 'd', createdAt: RECENT, pages: { p1: { targetId: 'GONE' } } }];
  const flagged = planReap({
    spaces: recentDead,
    liveTargetIds: ['L'],
    now: NOW,
    policy: { reapDeadSpaces: 1, dropDeadPages: 'yes', idleSpaceMs: FAR_IDLE, maxSpaces: 50 },
  });
  assert.deepEqual(flagged.closeSpaces, []);
  assert.deepEqual(flagged.dropPages, []);

  const liveWithDead = [{
    id: 1,
    name: 'live',
    createdAt: RECENT,
    pages: { p1: { targetId: 'LIVE' }, p2: { targetId: 'GONE' } },
  }];
  assert.deepEqual(
    planReap({
      spaces: liveWithDead,
      liveTargetIds: ['LIVE'],
      now: NOW,
      policy: { dropDeadPages: false, idleSpaceMs: FAR_IDLE },
    }).dropPages,
    [],
  );
});

test('non-object policy is ignored and falls back to defaults', () => {
  const spaces = [{ id: 1, name: 'd', createdAt: RECENT, pages: { p1: { targetId: 'GONE' } } }];
  for (const policy of [null, [], 'bad', 1]) {
    const plan = planReap({ spaces, liveTargetIds: ['L'], now: NOW, policy });
    assert.deepEqual(plan.closeSpaces, [1], String(policy));
  }
});

test('explicit undefined maxSpaces keeps the default cap of 50', () => {
  const atCap = planReap({
    spaces: Array.from({ length: 50 }, (_, i) => unbound(i + 1)),
    liveTargetIds: ['L'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE, maxSpaces: undefined },
  });
  assert.deepEqual(atCap.closeSpaces, []);
  assert.equal(atCap.stats.overCap, 0);

  const over = planReap({
    spaces: Array.from({ length: 51 }, (_, i) => unbound(i + 1)),
    liveTargetIds: ['L'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE, maxSpaces: undefined },
  });
  assert.deepEqual(over.closeSpaces, [1]);
  assert.equal(over.stats.overCap, 1);
});

test('cap coercion: null becomes 0, fractions truncate, non-finite disables', () => {
  const two = [unbound(1), unbound(2)];
  const nulled = planReap({
    spaces: two,
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: null, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(nulled.closeSpaces, [1, 2]);
  assert.equal(nulled.stats.overCap, 2);

  const half = planReap({
    spaces: two,
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: 1.5, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(half.closeSpaces, []);
  assert.equal(half.stats.overCap, 0);

  const four = [unbound(1), unbound(2), unbound(3), unbound(4)];
  const trunc = planReap({
    spaces: four,
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: 2.9, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(trunc.closeSpaces, [1]);
  assert.equal(trunc.stats.overCap, 1);

  const asOne = planReap({
    spaces: two,
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: true, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(asOne.closeSpaces, [1]);

  const asTwo = planReap({
    spaces: four,
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: '2', idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(asTwo.closeSpaces, [1, 2]);

  for (const maxSpaces of [NaN, -1, Infinity, 'nope']) {
    const plan = planReap({
      spaces: two,
      liveTargetIds: ['L'],
      now: NOW,
      policy: { maxSpaces, idleSpaceMs: FAR_IDLE },
    });
    assert.deepEqual(plan.closeSpaces, [], String(maxSpaces));
  }
});

test('cap never evicts live spaces and pinned rows consume slots', () => {
  const spaces = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `l${i + 1}`,
    createdAt: RECENT,
    pages: { p1: { targetId: 'LIVE' } },
  }));
  spaces.push(unbound(51));
  const plan = planReap({
    spaces,
    liveTargetIds: ['LIVE'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE, maxSpaces: 50 },
  });
  assert.deepEqual(plan.closeSpaces, [51]);
  assert.equal(plan.stats.live, 50);
  assert.equal(plan.stats.overCap, 1);

  const allLive = planReap({
    spaces: spaces.slice(0, 50),
    liveTargetIds: ['LIVE'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE, maxSpaces: 0 },
  });
  assert.deepEqual(allLive.closeSpaces, []);
  assert.equal(allLive.stats.overCap, 0);

  const pinned = planReap({
    spaces: [
      { id: 1, name: 'p', pinned: true, createdAt: RECENT, pages: { p1: { targetId: null } } },
      { id: 2, name: 'p2', pinned: true, createdAt: RECENT, pages: { p1: { targetId: null } } },
      unbound(3),
    ],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: 2, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(pinned.closeSpaces, [3]);
  assert.equal(pinned.stats.protected, 2);
  assert.equal(pinned.stats.overCap, 1);
});

test('numeric sort, name tie-break, id 0, and string pinned are not special-cased loosely', () => {
  const numeric = planReap({
    spaces: [unbound(10), unbound(2)],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: 0, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(numeric.closeSpaces, [2, 10]);

  const named = planReap({
    spaces: [
      { id: 'b', name: 'second', createdAt: RECENT, pages: { p1: { targetId: null } } },
      { id: 'a', name: 'first', createdAt: RECENT, pages: { p1: { targetId: null } } },
    ],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: 0, idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(named.closeSpaces, ['a', 'b']);

  const zero = planReap({
    spaces: [{ id: 0, name: 'z', createdAt: RECENT, pages: { p1: { targetId: 'GONE' } } }],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(zero.closeSpaces, [0]);

  const fakePin = planReap({
    spaces: [{ id: 1, name: 'p', pinned: 'true', createdAt: RECENT, pages: { p1: { targetId: 'GONE' } } }],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE },
  });
  assert.deepEqual(fakePin.closeSpaces, [1]);
  assert.equal(fakePin.stats.protected, 0);
});

test('protect accepts a scalar id and drops null entries', () => {
  const spaces = [
    { id: 1, name: 'a', createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
    { id: 2, name: 'b', createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
  ];
  const listed = planReap({ spaces, liveTargetIds: ['L'], now: NOW, protect: [null, undefined, 2] });
  assert.deepEqual(listed.closeSpaces, [1]);
  assert.equal(listed.stats.protected, 1);
  const scalar = planReap({ spaces, liveTargetIds: ['L'], now: NOW, protect: 2 });
  assert.deepEqual(scalar.closeSpaces, [1]);
  const none = planReap({ spaces, liveTargetIds: ['L'], now: NOW, protect: null });
  assert.deepEqual(none.closeSpaces, [1, 2]);
});

test('pinned live space is neither closed nor trimmed, including stale active ids', () => {
  const plan = planReap({
    spaces: [{
      id: 1,
      name: 'p',
      pinned: true,
      createdAt: RECENT,
      activeTargetId: 'GONE',
      pages: { p1: { targetId: 'LIVE' }, p2: { targetId: 'GONE' } },
    }],
    liveTargetIds: ['LIVE'],
    now: NOW,
  });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.equal(plan.stats.protected, 1);
  assert.equal(plan.stats.live, 0);
});

test('mixed idle closes the space; mixed recent only drops dead pages', () => {
  const idleMixed = planReap({
    spaces: [{
      id: 1,
      name: 'm',
      createdAt: OLD,
      pages: { p1: { targetId: 'GONE' }, p2: { targetId: null } },
    }],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { maxSpaces: 50 },
  });
  assert.deepEqual(idleMixed.closeSpaces, [1]);
  assert.deepEqual(idleMixed.dropPages, []);

  const recentMixed = planReap({
    spaces: [{
      id: 1,
      name: 'm',
      createdAt: RECENT,
      pages: { p1: { targetId: 'GONE' }, p2: { targetId: null } },
    }],
    liveTargetIds: ['L'],
    now: NOW,
    policy: { idleSpaceMs: FAR_IDLE, maxSpaces: 50 },
  });
  assert.deepEqual(recentMixed.closeSpaces, []);
  assert.deepEqual(recentMixed.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'GONE' }]);
});

test('over-cap closure strips drop entries and keeps a live stale active id', () => {
  const plan = planReap({
    spaces: [
      {
        id: 1,
        name: 'live',
        createdAt: RECENT,
        activeTargetId: 'GHOST',
        pages: { p1: { targetId: 'LIVE' }, p2: { targetId: 'DEAD' } },
      },
      { id: 2, name: 'unbound', createdAt: RECENT, activeTargetId: 'STALE', pages: { p1: { targetId: null } } },
      {
        id: 3,
        name: 'mixed',
        createdAt: RECENT,
        pages: { p1: { targetId: 'DEAD2' }, p2: { targetId: null } },
      },
      {
        id: 4,
        name: 'pin',
        createdAt: OLD,
        pinned: true,
        activeTargetId: 'GONE',
        pages: { p1: { targetId: 'GONE' } },
      },
      { id: 5, name: 'idle', createdAt: OLD, pages: { p1: { targetId: null } } },
    ],
    liveTargetIds: ['LIVE'],
    now: NOW,
    policy: { maxSpaces: 2 },
  });
  assert.equal('reason' in plan, false);
  assert.deepEqual(plan.closeSpaces, [2, 3, 5]);
  assert.deepEqual(plan.dropPages, [{ spaceId: 1, label: 'p2', targetId: 'DEAD' }]);
  assert.deepEqual(plan.staleActiveTargets, [{ spaceId: 1, targetId: 'GHOST' }]);
  assert.deepEqual(plan.stats, {
    examined: 5,
    skipped: 0,
    live: 1,
    protected: 1,
    closed: 3,
    pagesDropped: 1,
    staleActiveTargets: 1,
    overCap: 2,
  });
});

test('reapIdleWhenNoLiveTargets still honors pin and keeps a fresh unbound space', () => {
  const plan = planReap({
    spaces: [
      { id: 1, name: 'old', createdAt: OLD, pages: { p1: { targetId: null } } },
      { id: 2, name: 'new', createdAt: RECENT, pages: { p1: { targetId: null } } },
      { id: 3, name: 'pin', pinned: true, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
      { id: 4, name: 'dead', createdAt: RECENT, pages: { p1: { targetId: 'GONE' } } },
    ],
    liveTargetIds: [],
    now: NOW,
    policy: { reapIdleWhenNoLiveTargets: true, reapDeadSpaces: true, dropDeadPages: true, maxSpaces: 50 },
  });
  assert.equal(plan.reason, undefined);
  assert.deepEqual(plan.closeSpaces, [1, 4]);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.protected, 1);
});

test('applyReapPlan filters malformed drops, keeps falsy labels, and preserves id types', () => {
  const store = recorder();
  const plan = {
    closeSpaces: [1, 1],
    dropPages: [
      { spaceId: 1, label: 'p1' },
      { spaceId: '1', label: 'p-also' },
      null,
      { spaceId: 2 },
      { spaceId: 2, label: null },
      { spaceId: 2, label: 'p2' },
      { spaceId: 3, label: 0 },
      { spaceId: 3, label: '' },
    ],
  };
  const snapshot = structuredClone(plan);
  const result = applyReapPlan(store, plan);
  assert.deepEqual(plan, snapshot);
  assert.deepEqual(store.calls, [
    ['deleteSpace', 1],
    ['deleteSpace', 1],
    ['removePage', 2, 'p2'],
    ['removePage', 3, 0],
    ['removePage', 3, ''],
  ]);
  assert.equal(typeof store.calls[0][1], 'number');
  assert.deepEqual(result.closedSpaces, [1, 1]);
  assert.deepEqual(result.droppedPages, [
    { spaceId: 2, label: 'p2' },
    { spaceId: 3, label: 0 },
    { spaceId: 3, label: '' },
  ]);
});

test('applyReapPlan is a no-op without methods and does not catch store errors', () => {
  assert.deepEqual(
    applyReapPlan(null, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p' }] }),
    { closedSpaces: [], droppedPages: [] },
  );
  assert.deepEqual(
    applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'a' }] }),
    { closedSpaces: [], droppedPages: [] },
  );
  assert.deepEqual(applyReapPlan(recorder(), undefined), { closedSpaces: [], droppedPages: [] });
  assert.deepEqual(applyReapPlan(recorder(), { closeSpaces: 'nope', dropPages: 'nope' }), {
    closedSpaces: [],
    droppedPages: [],
  });

  const dropsOnly = [];
  const dropStore = { removePage(id, label) { dropsOnly.push([id, label]); } };
  const dropped = applyReapPlan(dropStore, { closeSpaces: [1], dropPages: [{ spaceId: 3, label: 'p' }] });
  assert.deepEqual(dropped.closedSpaces, []);
  assert.deepEqual(dropsOnly, [[3, 'p']]);

  const closesOnly = [];
  const closeStore = { deleteSpace(id) { closesOnly.push(id); } };
  const closed = applyReapPlan(closeStore, { closeSpaces: [4], dropPages: [{ spaceId: 5, label: 'p' }] });
  assert.deepEqual(closed.droppedPages, []);
  assert.deepEqual(closesOnly, [4]);

  let deleted = 0;
  assert.throws(() => applyReapPlan({
    deleteSpace() { deleted += 1; },
    removePage() { throw new Error('rm'); },
  }, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p1' }] }), /rm/);
  assert.equal(deleted, 1);
  assert.throws(() => applyReapPlan({
    deleteSpace() { throw new Error('boom'); },
  }, { closeSpaces: [7] }), /boom/);
});

test('apply on a real Store drops a dead page, clears activeTargetId, and is repeatable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-reaper-'));
  try {
    const store = new Store(join(dir, 'ledger.json'));
    const live = store.create({ name: 'live' });
    const dead = store.create({ name: 'dead' });
    store.bindPage(live.id, 'p1', 'LIVE');
    store.addPage(live.id, 'p2', 'DEAD');
    store.get(live.id).activeTargetId = 'DEAD';
    store.bindPage(dead.id, 'p1', 'GONE');
    store.get(dead.id).activeTargetId = 'GONE';
    store.persist();

    const plan = planReap({
      spaces: store.list(),
      liveTargetIds: ['LIVE'],
      now: Date.now(),
      policy: { maxSpaces: 50, idleSpaceMs: FAR_IDLE, reapDeadSpaces: true, dropDeadPages: true },
    });
    assert.deepEqual(plan.closeSpaces, [dead.id]);
    assert.deepEqual(plan.dropPages, [{ spaceId: live.id, label: 'p2', targetId: 'DEAD' }]);

    applyReapPlan(store, plan);
    const again = new Store(join(dir, 'ledger.json'));
    assert.equal(again.get(dead.id), null);
    assert.equal(Object.hasOwn(again.data.labelSeq, String(dead.id)), false);
    assert.equal(again.data.labelSeq[live.id], 1);
    assert.equal(again.get(live.id).activeTargetId, null);
    assert.deepEqual(again.get(live.id).pages.p1, {
      targetId: 'LIVE', openedBy: 'agent', title: '', url: '',
    });
    assert.equal(Object.hasOwn(again.get(live.id).pages, 'p2'), false);

    const second = applyReapPlan(store, plan);
    assert.deepEqual(second.closedSpaces, [dead.id]);
    assert.deepEqual(second.droppedPages, [{ spaceId: live.id, label: 'p2', targetId: 'DEAD' }]);
    assert.equal(store.get(live.id).pages.p1.targetId, 'LIVE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
