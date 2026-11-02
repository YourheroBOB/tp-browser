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
