// Payload-shape edges for fmb_feature2/cli.js buildPlan().
// Does not spawn the CLI and does not repeat dry-run exit-code coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../fmb_feature2/cli.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const RECENT = '2026-06-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';

test('non-JSON text and non-object JSON are rejected', () => {
  for (const input of ['', '{', undefined, {}, 'undefined']) {
    assert.throws(() => buildPlan(input), /invalid JSON input:/);
  }
  for (const input of ['null', '[]', '1', '"x"', 'true', '  \n null \t', 42]) {
    assert.throws(() => buildPlan(input), /payload must be a JSON object/);
  }
});

test('missing, null, and non-array fields use the conservative defaults', () => {
  const empty = buildPlan('{}');
  assert.equal(empty.reason, 'no-live-targets');
  assert.equal(empty.stats.examined, 0);
  assert.deepEqual(empty.closeSpaces, []);

  const spacesNull = buildPlan(`{"spaces":null,"liveTargetIds":["LIVE"],"now":${NOW}}`);
  assert.equal(spacesNull.reason, undefined);
  assert.equal(spacesNull.stats.examined, 0);

  const liveNull = buildPlan(JSON.stringify({
    spaces: [{ id: 1, name: 'd', createdAt: OLD, pages: { p1: { targetId: 'Z' } } }],
    liveTargetIds: null,
    now: NOW,
  }));
  assert.equal(liveNull.reason, 'no-live-targets');
  assert.deepEqual(liveNull.closeSpaces, []);

  const liveZero = buildPlan(JSON.stringify({
    spaces: [{ id: 1, name: 'd', createdAt: OLD, pages: { p1: { targetId: 'GONE' } } }],
    liveTargetIds: 0,
    now: NOW,
  }));
  assert.equal(liveZero.reason, 'no-live-targets');
  assert.deepEqual(liveZero.closeSpaces, []);

  const spacesObject = buildPlan('{"spaces":{"id":1},"liveTargetIds":["A"]}');
  assert.equal(spacesObject.reason, 'invalid-input');
  assert.deepEqual(spacesObject.closeSpaces, []);
});

test('now must already be a number; 0 is kept and numeric strings are ignored', () => {
  const recent = buildPlan(JSON.stringify({
    spaces: [{ id: 7, name: 'u', createdAt: new Date().toISOString(), pages: { p1: { targetId: null } } }],
    liveTargetIds: ['LIVE'],
    now: '99999999999999',
    policy: { maxSpaces: 50 },
  }));
  assert.deepEqual(recent.closeSpaces, []);
  assert.equal(recent.reason, undefined);

  const keptZero = buildPlan(JSON.stringify({
    spaces: [{ id: 1, name: 'u', createdAt: 0, pages: { p1: { targetId: null } } }],
    liveTargetIds: ['L'],
    now: 0,
    policy: { idleSpaceMs: 1, maxSpaces: 50 },
  }));
  assert.deepEqual(keptZero.closeSpaces, []);

  const crossed = buildPlan(JSON.stringify({
    spaces: [{ id: 1, name: 'u', createdAt: 0, pages: { p1: { targetId: null } } }],
    liveTargetIds: ['L'],
    now: 1000,
    policy: { idleSpaceMs: 1000, maxSpaces: 50 },
  }));
  assert.deepEqual(crossed.closeSpaces, [1]);
});

test('scalar protect is forwarded, including falsy id 0', () => {
  const plan = buildPlan(JSON.stringify({
    spaces: [{ id: 0, name: 'z', createdAt: OLD, pages: { p1: { targetId: 'GONE' } } }],
    liveTargetIds: ['L'],
    now: NOW,
    protect: 0,
    note: 'ignore-me',
  }));
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(plan.stats.protected, 1);

  const unprotected = buildPlan(JSON.stringify({
    spaces: [{ id: 1, name: 'd', createdAt: RECENT, pages: { p1: { targetId: 'GONE' } } }],
    liveTargetIds: ['L'],
    now: NOW,
    extra: true,
  }));
  assert.deepEqual(unprotected.closeSpaces, [1]);
});

function ancient(now) {
  const body = {
    liveTargetIds: ['keep'],
    policy: { idleSpaceMs: 1, reapDeadSpaces: false, maxSpaces: 50 },
    spaces: [
      { id: 1, createdAt: '1970-01-01T00:00:00.000Z', pages: { p1: { targetId: 'keep' } } },
      { id: 2, createdAt: '1970-01-01T00:00:00.000Z', pages: {} },
    ],
  };
  if (now !== undefined) body.now = now;
  return JSON.stringify(body);
}

test('JSON that is not an object is rejected', () => {
  for (const raw of ['[]', 'null', '1', '"x"', 'true']) {
    assert.throws(() => buildPlan(raw), /payload must be a JSON object/);
  }
});

test('malformed text, a BOM, and a non-string argument fail as invalid JSON', () => {
  for (const raw of ['', '   ', '{', '\uFEFF{}', undefined]) {
    assert.throws(() => buildPlan(raw), /invalid JSON input:/);
  }
  assert.throws(() => buildPlan({ spaces: [] }), /invalid JSON input:/);
});

test('an empty object is a no-live-targets plan and does not throw', () => {
  const plan = buildPlan('{}');
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.examined, 0);
  assert.equal(plan.stats.skipped, 0);
});

test('now must be a number; 0 is kept and null or a numeric string is not', () => {
  assert.deepEqual(buildPlan(ancient(0)).closeSpaces, []);
  assert.deepEqual(buildPlan(ancient(null)).closeSpaces, [2]);
  assert.deepEqual(buildPlan(ancient('0')).closeSpaces, [2]);
  assert.deepEqual(buildPlan(ancient()).closeSpaces, [2]);
});

test('policy is forwarded, so a dead space can stay open while its page is dropped', () => {
  const plan = buildPlan(JSON.stringify({
    now: 0,
    liveTargetIds: ['keep'],
    policy: { reapDeadSpaces: false, dropDeadPages: true, idleSpaceMs: 10_000, maxSpaces: 50 },
    spaces: [{ id: 5, createdAt: 0, pages: { p1: { targetId: 'T-EDGE-GONE' } } }],
  }));
  assert.equal(plan.reason, undefined);
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, [{ spaceId: 5, label: 'p1', targetId: 'T-EDGE-GONE' }]);
});

test('protect is forwarded as a bare string id', () => {
  const plan = buildPlan(JSON.stringify({
    now: 0,
    liveTargetIds: ['keep'],
    protect: '4',
    spaces: [
      { id: 4, createdAt: 0, pages: { p1: { targetId: 'T-EDGE-GONE' } } },
      { id: 5, createdAt: 0, pages: { p1: { targetId: 'T-EDGE-GONE' } } },
    ],
  }));
  assert.deepEqual(plan.closeSpaces, [5]);
  assert.equal(plan.stats.protected, 1);
});

test('a non-array spaces field is invalid-input rather than an exception', () => {
  const plan = buildPlan(JSON.stringify({ spaces: 'nope', liveTargetIds: ['T-EDGE-LIVE'] }));
  assert.equal(plan.reason, 'invalid-input');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
});
