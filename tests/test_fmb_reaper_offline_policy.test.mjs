// Reaper／乾跑 CLI 回歸：離線安全閥、上限、保護、以及套用到真實 Store。
// 只讀寫 os.tmpdir()，不連線。node:test 的 todo 等同 xfail。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import { buildPlan } from '../fmb_feature2/cli.js';
import {
  DEFAULT_POLICY,
  applyReapPlan,
  classifySpace,
  planReap,
} from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const IDLE = 30 * 60 * 1000;
const OLD = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
const NEW = new Date(NOW).toISOString();

function pg(targetId) {
  return { targetId, openedBy: 'agent', title: '', url: '' };
}

function sp(id, pages, extra = {}) {
  return {
    id,
    name: extra.name ?? `s${id}`,
    createdAt: extra.createdAt ?? NEW,
    pinned: extra.pinned ?? false,
    activeTargetId: extra.activeTargetId ?? null,
    pages,
  };
}

describe('reaper policy edges and Store apply', { concurrency: false }, () => {
  it('classifies live, dead, unbound, empty, and mixed spaces', () => {
    const cases = [
      ['live', { p1: pg('T-live') }, 'live'],
      ['dead', { p1: pg('T-dead') }, 'dead'],
      ['unbound', { p1: pg(null) }, 'unbound'],
      ['empty', {}, 'empty'],
      ['mixed', { p1: pg('T-dead'), p2: pg(null) }, 'mixed'],
      ['live wins', { p1: pg('T-live'), p2: pg('T-dead') }, 'live'],
      ['null page ignored', { p1: null, p2: pg('T-dead') }, 'dead'],
    ];
    for (const [name, pages, kind] of cases) {
      const info = classifySpace(sp(1, pages), { liveTargets: ['T-live'], now: NOW });
      assert.equal(info.kind, kind, name);
    }
  });

  it('treats non-string target ids as unbound and a future timestamp as age 0', () => {
    const numeric = classifySpace(
      sp(1, { p1: { targetId: 15, openedBy: 'agent', title: '', url: '' } }),
      { liveTargets: ['15', 15], now: NOW },
    );
    assert.equal(numeric.kind, 'unbound');
    assert.equal(numeric.livePages.length, 0);
    assert.equal(numeric.deadPages.length, 0);

    const future = classifySpace(sp(1, {}, { createdAt: NOW + 60_000 }), { liveTargets: [], now: NOW });
    assert.equal(future.kind, 'empty');
    assert.equal(future.ageMs, 0);
    assert.equal(future.idle, false);

    const missingClock = classifySpace(
      { id: 1, pages: { p1: pg('gone') } },
      { liveTargets: ['T-live'], now: NOW },
    );
    assert.equal(missingClock.ageMs, null);
    assert.equal(missingClock.idle, false);
    assert.equal(missingClock.kind, 'dead');
  });

  it('idle boundary is inclusive, and empty spaces use the same clock', () => {
    const plan = planReap({
      spaces: [
        sp(1, { p1: pg(null) }, { createdAt: NOW - IDLE }),
        sp(2, { p1: pg(null) }, { createdAt: NOW - IDLE + 1 }),
        sp(3, {}, { createdAt: NOW - IDLE }),
        sp(4, {}, { createdAt: NEW }),
      ],
      liveTargetIds: ['T-anchor'],
      now: NOW,
      policy: { idleSpaceMs: IDLE, maxSpaces: 50 },
    });
    assert.deepEqual(plan.closeSpaces, [1, 3]);
    assert.equal(plan.reason, undefined);
  });

  it('does nothing when the live set is empty or only contains unusable ids', () => {
    const spaces = [
      sp(1, { p1: pg('T-old') }, { createdAt: OLD }),
      sp(2, { p1: pg(null) }, { createdAt: OLD }),
    ];
    const snapshot = JSON.stringify(spaces);
    const plan = planReap({ spaces, liveTargetIds: ['', 12, null], now: NOW });
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
    assert.deepEqual(plan.staleActiveTargets, []);
    assert.equal(plan.stats.examined, 2);
    assert.equal(plan.stats.skipped, 0);
    assert.equal(plan.stats.closed, 0);
    assert.equal(JSON.stringify(spaces), snapshot);

    const missed = planReap({
      spaces: [sp(1, { p1: pg('12') })],
      liveTargetIds: [12],
      now: NOW,
    });
    assert.equal(missed.reason, 'no-live-targets');
    const hit = planReap({
      spaces: [sp(1, { p1: pg('12') })],
      liveTargetIds: ['12'],
      now: NOW,
    });
    assert.equal(hit.reason, undefined);
    assert.equal(hit.stats.live, 1);
    assert.deepEqual(hit.closeSpaces, []);
  });

  it('rejects a non-array spaces input without throwing', () => {
    for (const spaces of [null, undefined, {}, 'x', 1]) {
      const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW });
      assert.equal(plan.reason, 'invalid-input');
      assert.deepEqual(plan.closeSpaces, []);
      assert.deepEqual(plan.dropPages, []);
      assert.equal(plan.stats.examined, 0);
      assert.equal(plan.stats.skipped, 0);
    }
  });

  it('plans drops, closes, protection, and stale targets in id order', () => {
    const spaces = [
      null,
      { name: 'no-id', pages: { p1: pg('T-live') } },
      sp(1, { p1: pg('T-live'), p2: pg('T-dead') }, { activeTargetId: 'T-live' }),
      sp(2, { p1: pg('T-gone') }, { activeTargetId: 'T-gone' }),
      sp(3, { p1: pg(null) }),
      sp(4, { p1: pg('T-pin') }, { pinned: true, createdAt: OLD, activeTargetId: 'T-pin' }),
      sp(5, { p1: pg('T-prot') }, { createdAt: OLD, activeTargetId: 'T-prot' }),
      sp(6, { p1: pg('T-gone'), p2: pg(null) }),
      sp(7, { p1: pg(null) }, { activeTargetId: 'stale' }),
    ];
    const snapshot = JSON.stringify(spaces);
    const plan = planReap({
      spaces,
      liveTargetIds: ['T-live', '', 12, null],
      now: NOW,
      protect: [5],
    });
    assert.equal(JSON.stringify(spaces), snapshot);
    assert.deepEqual(plan.closeSpaces, [2]);
    assert.deepEqual(plan.dropPages, [
      { spaceId: 1, label: 'p2', targetId: 'T-dead' },
      { spaceId: 6, label: 'p1', targetId: 'T-gone' },
    ]);
    assert.deepEqual(plan.staleActiveTargets, [{ spaceId: 7, targetId: 'stale' }]);
    assert.deepEqual(plan.stats, {
      examined: 7,
      skipped: 2,
      live: 1,
      protected: 2,
      closed: 1,
      pagesDropped: 2,
      staleActiveTargets: 1,
      overCap: 0,
    });
  });

  it('leaves a pinned live space completely untouched', () => {
    const plan = planReap({
      spaces: [sp(1, { p1: pg('T-live'), p2: pg('T-dead') }, { pinned: true, activeTargetId: 'T-dead' })],
      liveTargetIds: ['T-live'],
      now: NOW,
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
    assert.deepEqual(plan.staleActiveTargets, []);
    assert.equal(plan.stats.protected, 1);
    assert.equal(plan.stats.live, 0);
  });

  it('can drop every dead page while keeping the space when reapDeadSpaces is off', () => {
    const plan = planReap({
      spaces: [sp(1, { p1: pg('gone'), p2: pg('gone2') })],
      liveTargetIds: ['T-live'],
      now: NOW,
      policy: { reapDeadSpaces: false, dropDeadPages: true, idleSpaceMs: IDLE },
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages.map((entry) => entry.label), ['p1', 'p2']);
  });

  it('closes a dead space without listing its pages when dropDeadPages is off', () => {
    const plan = planReap({
      spaces: [sp(1, { p1: pg('gone') }, { activeTargetId: 'gone' })],
      liveTargetIds: ['T-live'],
      now: NOW,
      policy: { reapDeadSpaces: true, dropDeadPages: false },
    });
    assert.deepEqual(plan.closeSpaces, [1]);
    assert.deepEqual(plan.dropPages, []);
    assert.deepEqual(plan.staleActiveTargets, []);
  });

  it('over-cap never sacrifices a live or pinned space', () => {
    const plan = planReap({
      spaces: [
        sp(1, { p1: pg('T-live') }),
        sp(2, { p1: pg(null) }, { pinned: true }),
        sp(3, { p1: pg(null) }),
        sp(4, { p1: pg(null) }),
      ],
      liveTargetIds: ['T-live'],
      now: NOW,
      policy: { maxSpaces: 1, idleSpaceMs: IDLE },
    });
    assert.deepEqual(plan.closeSpaces, [3, 4]);
    assert.equal(plan.stats.overCap, 2);
    assert.equal(plan.stats.live, 1);
    assert.equal(plan.stats.protected, 1);
    assert.equal(plan.stats.closed, 2);
  });

  it('treats NaN maxSpaces as no cap and does not mutate the caller policy', () => {
    const policy = { maxSpaces: NaN, idleSpaceMs: 1e15, reapDeadSpaces: false, dropDeadPages: false };
    const plan = planReap({
      spaces: [sp(1, { p1: pg(null) }), sp(2, { p1: pg(null) }), sp(3, { p1: pg(null) })],
      liveTargetIds: ['T-anchor'],
      now: NOW,
      policy,
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.equal(policy.maxSpaces, NaN);
    assert.equal(Object.keys(policy).length, 4);
    assert.equal(DEFAULT_POLICY.maxSpaces, 50);
    assert.equal(DEFAULT_POLICY.reapIdleWhenNoLiveTargets, false);
    assert.equal(DEFAULT_POLICY.reapDeadSpaces, true);
    assert.throws(() => {
      DEFAULT_POLICY.maxSpaces = 1;
    }, TypeError);
    assert.equal(DEFAULT_POLICY.maxSpaces, 50);
  });

  it('offline idle opt-in still closes only an old unbound space', () => {
    const oldPlan = planReap({
      spaces: [sp(1, { p1: pg(null) }, { createdAt: OLD })],
      liveTargetIds: [],
      now: NOW,
      policy: { reapIdleWhenNoLiveTargets: true, idleSpaceMs: IDLE },
    });
    assert.equal(oldPlan.reason, undefined);
    assert.deepEqual(oldPlan.closeSpaces, [1]);

    const youngPlan = planReap({
      spaces: [sp(1, { p1: pg(null) })],
      liveTargetIds: [],
      now: NOW,
      policy: { reapIdleWhenNoLiveTargets: true, idleSpaceMs: IDLE },
    });
    assert.deepEqual(youngPlan.closeSpaces, []);
    assert.deepEqual(youngPlan.dropPages, []);
  });

  it('offline idle opt-in does not treat a young bound space as dead', {
    todo: 'empty live set makes every bound target look dead, so reapDeadSpaces closes it',
  }, () => {
    const plan = planReap({
      spaces: [sp(1, { p1: pg('T-was-live') })],
      liveTargetIds: [],
      now: NOW,
      policy: { reapIdleWhenNoLiveTargets: true, reapDeadSpaces: true, idleSpaceMs: IDLE },
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
  });

  it('offline idle opt-in does not drop pages just because the live set is empty', {
    todo: 'dropDeadPages runs against an empty live set and strips every bound page',
  }, () => {
    const plan = planReap({
      spaces: [sp(1, { p1: pg('T-was-live'), p2: pg(null) })],
      liveTargetIds: [],
      now: NOW,
      policy: {
        reapIdleWhenNoLiveTargets: true,
        reapDeadSpaces: false,
        dropDeadPages: true,
        idleSpaceMs: IDLE,
      },
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
  });

  it('treats maxSpaces null as unlimited', {
    todo: 'Number(null)===0, so null becomes a cap of zero and closes every non-live space',
  }, () => {
    const plan = planReap({
      spaces: [1, 2, 3].map((id) => sp(id, { p1: pg(null) })),
      liveTargetIds: ['T-anchor'],
      now: NOW,
      policy: { maxSpaces: null, idleSpaceMs: 1e15, reapDeadSpaces: false, dropDeadPages: false },
    });
    assert.deepEqual(plan.closeSpaces, []);
  });

  it('lists each space id at most once', {
    todo: 'duplicate space ids are both appended to closeSpaces',
  }, () => {
    const plan = planReap({
      spaces: [
        sp(1, { p1: pg('gone-a') }),
        sp(1, { p1: pg('gone-b') }),
      ],
      liveTargetIds: ['T-live'],
      now: NOW,
    });
    assert.deepEqual(plan.closeSpaces, [1]);
  });

  it('over-cap reaping starts at the oldest createdAt', {
    todo: 'compareSpaces orders by id before createdAt, so the newer low id is sacrificed',
  }, () => {
    const plan = planReap({
      spaces: [
        sp(1, { p1: pg(null) }, { createdAt: NEW }),
        sp(9, { p1: pg(null) }, { createdAt: NOW - 10 * 60 * 1000 }),
      ],
      liveTargetIds: ['T-anchor'],
      now: NOW,
      policy: { maxSpaces: 1, idleSpaceMs: 24 * 60 * 60 * 1000 },
    });
    assert.deepEqual(plan.closeSpaces, [9]);
  });

  it('applyReapPlan skips closed-space drops, bad entries, and missing methods', () => {
    const calls = [];
    const result = applyReapPlan({
      deleteSpace(id) { calls.push(['del', id]); },
      removePage(id, label) { calls.push(['drop', id, label]); },
    }, {
      closeSpaces: [1],
      dropPages: [
        { spaceId: 1, label: 'p1' },
        { spaceId: 2, label: 'p9', targetId: 'T-dead' },
        { spaceId: 3 },
        null,
      ],
    });
    assert.deepEqual(calls, [['del', 1], ['drop', 2, 'p9']]);
    assert.deepEqual(result.closedSpaces, [1]);
    assert.deepEqual(result.droppedPages, [{ spaceId: 2, label: 'p9', targetId: 'T-dead' }]);

    const dropped = [];
    const partial = applyReapPlan(
      { removePage(id, label) { dropped.push([id, label]); } },
      { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p1' }] },
    );
    assert.deepEqual(partial.closedSpaces, []);
    assert.deepEqual(dropped, [[2, 'p1']]);
    assert.deepEqual(
      applyReapPlan(null, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p1' }] }),
      { closedSpaces: [], droppedPages: [] },
    );
    assert.deepEqual(applyReapPlan({}, null), { closedSpaces: [], droppedPages: [] });
  });

  it('applyReapPlan on Store drops the dead page, clears activeTargetId, and deletes labelSeq', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-reaper-store-'));
    try {
      const path = join(dir, 'ledger.json');
      const store = new Store(path);
      const live = store.create({ name: 'live' });
      const dead = store.create({ name: 'dead' });
      const pinned = store.create({ name: 'pinned' });
      for (const entry of [live, dead, pinned]) entry.createdAt = NEW;

      store.bindPage(live.id, 'p1', 'T-live');
      store.addPage(live.id, 'p2', 'T-dead');
      store.setPage(live.id, 'p1', { title: 'keep' });
      live.activeTargetId = 'T-dead';
      store.setPage(live.id, 'p2', { title: 'drop-me' });

      store.bindPage(dead.id, 'p1', 'T-gone');
      dead.activeTargetId = 'T-gone';
      store.setPage(dead.id, 'p1', { title: 'gone' });

      store.bindPage(pinned.id, 'p1', 'T-pinned-gone');
      pinned.pinned = true;
      store.setPage(pinned.id, 'p1', { title: 'pin' });

      const plan = planReap({
        spaces: store.list(),
        liveTargetIds: ['T-live'],
        now: NOW,
        policy: { idleSpaceMs: IDLE, maxSpaces: 50 },
      });
      assert.deepEqual(plan.closeSpaces, [dead.id]);
      assert.deepEqual(plan.dropPages, [{ spaceId: live.id, label: 'p2', targetId: 'T-dead' }]);

      applyReapPlan(store, plan);
      assert.doesNotThrow(() => applyReapPlan(store, plan));

      const again = new Store(path);
      assert.equal(again.get(dead.id), null);
      assert.equal(again.get(live.id).pages.p1.targetId, 'T-live');
      assert.equal(again.get(live.id).pages.p1.title, 'keep');
      assert.equal(Object.hasOwn(again.get(live.id).pages, 'p2'), false);
      assert.equal(again.get(live.id).activeTargetId, null);
      assert.equal(again.get(pinned.id).pages.p1.targetId, 'T-pinned-gone');
      assert.equal(again.get(pinned.id).pages.p1.title, 'pin');
      assert.equal(again.get(pinned.id).pinned, true);

      const disk = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(disk.nextSpaceId, 4);
      assert.equal(Object.hasOwn(disk.labelSeq, String(dead.id)), false);
      assert.equal(disk.labelSeq[String(live.id)], 1);
      assert.equal(disk.labelSeq[String(pinned.id)], 1);

      const plan2 = planReap({
        spaces: again.list(),
        liveTargetIds: ['T-live'],
        now: NOW,
      });
      assert.deepEqual(plan2.closeSpaces, []);
      assert.deepEqual(plan2.dropPages, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildPlan honors now and policy, and rejects a non-object payload', () => {
    const createdAt = '2100-01-01T00:00:00.000Z';
    const createdMs = Date.parse(createdAt);
    const body = {
      spaces: [{ id: 1, createdAt, pages: { p1: { targetId: null } } }],
      liveTargetIds: ['T-anchor'],
    };
    const idle = buildPlan(JSON.stringify({ ...body, now: createdMs + IDLE }));
    assert.deepEqual(idle.closeSpaces, [1]);
    const fresh = buildPlan(JSON.stringify({ ...body, now: createdMs }));
    assert.deepEqual(fresh.closeSpaces, []);
    const widened = buildPlan(JSON.stringify({
      ...body,
      now: createdMs + IDLE,
      policy: { idleSpaceMs: createdMs },
    }));
    assert.deepEqual(widened.closeSpaces, []);

    const protectedPlan = buildPlan(JSON.stringify({
      spaces: [{ id: 7, createdAt: OLD, pages: { p1: { targetId: 'gone' } } }],
      liveTargetIds: ['T-live'],
      now: NOW,
      protect: [7],
    }));
    assert.deepEqual(protectedPlan.closeSpaces, []);
    assert.equal(protectedPlan.stats.protected, 1);

    const omitted = buildPlan(JSON.stringify({ liveTargetIds: ['T-live'] }));
    assert.equal(omitted.reason, undefined);
    assert.deepEqual(omitted.closeSpaces, []);
    assert.equal(omitted.stats.examined, 0);

    assert.throws(() => buildPlan('{'), /invalid JSON input/);
    assert.throws(() => buildPlan(''), /invalid JSON input/);
    assert.throws(() => buildPlan('null'), /payload must be a JSON object/);
    assert.throws(() => buildPlan('[]'), /payload must be a JSON object/);
    assert.throws(() => buildPlan('"x"'), /payload must be a JSON object/);
  });
});
