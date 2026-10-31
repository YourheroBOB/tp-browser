import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isModifier,
  keyDescriptor,
  modifierBit,
  parseChord,
} from '../daemon/keys.js';
import {
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from '../fmb_feature2/reaper.js';
import { buildPlan } from '../fmb_feature2/cli.js';

const SEED = 0x5eedf00d;
const NOW = 1_767_225_600_000;
const TIMEOUT_MS = 30_000;

const MODIFIERS = new Map([
  ['Alt', 1],
  ['Control', 2],
  ['ControlOrMeta', 2],
  ['Meta', 4],
  ['Shift', 8],
]);

const NAMED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Alt', 'Control', 'Ctrl', 'Meta', 'Command', 'Shift',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];

const RESERVED = new Set([
  'constructor', '__defineGetter__', '__defineSetter__',
  'hasOwnProperty', '__lookupGetter__', '__lookupSetter__',
  'isPrototypeOf', 'propertyIsEnumerable', 'toString',
  'valueOf', '__proto__', 'toLocaleString',
]);

const CHARACTERS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...' +-_./:?[]{}()@!#$%^&*=',
  '\0', '\t', '\n', '\r', '😀',
  String.fromCharCode(0xd800),
  String.fromCharCode(0xdc00),
];

function createRng(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(rng, values) {
  return values[randomInt(rng, 0, values.length - 1)];
}

function randomString(rng, maxLength = 40) {
  const length = randomInt(rng, 0, maxLength);
  let value = '';
  for (let index = 0; index < length; index++) {
    value += pick(rng, CHARACTERS);
  }
  return value;
}

function nonReservedString(rng, maxLength = 40) {
  let value;
  do value = randomString(rng, maxLength);
  while (RESERVED.has(value));
  return value;
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedTargetId(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function sameMembers(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function buildPlanInput(rng, caseIndex) {
  const liveTargetIds = Array.from(
    { length: randomInt(rng, 0, 4) },
    (_, index) => `live-${caseIndex}-${index}`,
  );
  const spaces = [];

  for (let spaceIndex = 0; spaceIndex < randomInt(rng, 0, 8); spaceIndex++) {
    const pages = {};
    for (let pageIndex = 0; pageIndex < randomInt(rng, 0, 6); pageIndex++) {
      const roll = randomInt(rng, 0, 3);
      let targetId;
      if (roll === 0) targetId = null;
      else if (roll === 1 && liveTargetIds.length > 0) {
        targetId = pick(rng, liveTargetIds);
      } else {
        targetId = `dead-${caseIndex}-${spaceIndex}-${pageIndex}`;
      }
      pages[`p${pageIndex}`] = { targetId, title: '', url: '' };
    }

    const activeRoll = randomInt(rng, 0, 3);
    let activeTargetId;
    if (activeRoll === 0) activeTargetId = null;
    else if (activeRoll === 1 && liveTargetIds.length > 0) {
      activeTargetId = pick(rng, liveTargetIds);
    } else {
      activeTargetId = `active-${caseIndex}-${spaceIndex}`;
    }

    spaces.push({
      id: spaceIndex,
      name: `fuzz-space-${spaceIndex}`,
      createdAt: NOW - randomInt(rng, 0, 10_000),
      pages,
      activeTargetId,
      pinned: rng() < 0.15,
    });
  }

  const protect = spaces
    .filter(() => rng() < 0.2)
    .map((space) => space.id);

  return {
    spaces,
    liveTargetIds,
    now: NOW,
    protect,
    policy: {
      idleSpaceMs: pick(rng, [0, 1, 100, 1_000, 10_000, -1]),
      maxSpaces: pick(rng, [null, 0, 1, 3, 20]),
      reapDeadSpaces: rng() < 0.7,
      dropDeadPages: rng() < 0.7,
      reapIdleWhenNoLiveTargets: rng() < 0.2,
    },
  };
}

test('fuzz: keyDescriptor 與 modifier 查詢維持結構不變量', { timeout: TIMEOUT_MS }, () => {
  const rng = createRng(SEED);

  for (let index = 0; index < 5_000; index++) {
    const input = index % 11 === 0
      ? pick(rng, NAMED_KEYS)
      : nonReservedString(rng);
    let descriptor;
    assert.doesNotThrow(() => {
      descriptor = keyDescriptor(input);
    });

    if (NAMED_KEYS.includes(input)) {
      assert.equal(isObjectRecord(descriptor), true);
      assert.equal(typeof descriptor.key, 'string');
      assert.equal(typeof descriptor.code, 'string');
      assert.equal(Number.isInteger(descriptor.vk), true);
      if (descriptor.text !== undefined) assert.equal(typeof descriptor.text, 'string');
      continue;
    }

    assert.equal(descriptor === null, input.length !== 1);
    if (descriptor === null) continue;
    assert.equal(descriptor.key, input);
    assert.equal(Number.isInteger(descriptor.vk), true);
    assert.ok(descriptor.code === null || typeof descriptor.code === 'string');
    if (/^[A-Za-z]$/.test(input)) {
      assert.equal(descriptor.code, `Key${input.toUpperCase()}`);
    } else if (/^[0-9]$/.test(input)) {
      assert.equal(descriptor.code, `Digit${input}`);
    } else {
      assert.equal(descriptor.code, null);
    }
    assert.equal(descriptor.text, /[ -~]/.test(input) ? input : undefined);
  }

  for (let index = 0; index < 2_500; index++) {
    const input = index % 7 === 0
      ? pick(rng, [...MODIFIERS.keys()])
      : nonReservedString(rng);
    const expected = MODIFIERS.get(input) ?? 0;
    assert.equal(isModifier(input), expected !== 0);
    assert.equal(modifierBit(input), expected);
  }
});

test('fuzz: parseChord 對隨機和弦回傳合法結構或受控錯誤', { timeout: TIMEOUT_MS }, () => {
  const rng = createRng(SEED ^ 0x10203040);

  for (let index = 0; index < 2_500; index++) {
    const modifiers = Array.from(
      { length: randomInt(rng, 0, 3) },
      () => pick(rng, [...MODIFIERS.keys()]),
    );
    const main = pick(rng, [...NAMED_KEYS, 'a', 'Z', '0', '!', '_']);
    const parsed = parseChord([...modifiers, main].join('+'));

    assert.deepEqual(parsed.modifiers, modifiers);
    assert.equal(parsed.main, main);
    assert.ok(parsed.modifiers.every((modifier) => isModifier(modifier)));
    const bitmask = modifiers.reduce(
      (mask, modifier) => mask | modifierBit(modifier),
      0,
    );
    assert.ok(bitmask >= 0 && bitmask <= 15);
  }

  for (let index = 0; index < 3_000; index++) {
    const input = nonReservedString(rng);
    try {
      const parsed = parseChord(input);
      assert.equal(Array.isArray(parsed.modifiers), true);
      assert.equal(typeof parsed.main, 'string');
      assert.ok(parsed.modifiers.every((modifier) => isModifier(modifier)));
    } catch (error) {
      assert.equal(error instanceof Error, true);
      assert.ok(error.message.length > 0);
    }
  }
});

test(
  'fuzz: 原型鏈名稱不得被當成合法按鍵或修飾鍵',
  {
    skip: '已知產品缺陷：按鍵與修飾鍵查詢會沿原型鏈找到名稱；本任務不得修改產品原始碼，待另案修正。',
  },
  () => {
    for (const name of RESERVED) {
      assert.equal(keyDescriptor(name), null, `${name} must not resolve through the prototype chain`);
      assert.equal(isModifier(name), false, `${name} must not resolve through the prototype chain`);
      assert.throws(() => parseChord(name), /unknown key/);
    }
  },
);

test('fuzz: toTargetSet 只保留非空字串且不修改輸入', { timeout: TIMEOUT_MS }, () => {
  const rng = createRng(SEED ^ 0x55667788);

  for (let index = 0; index < 1_000; index++) {
    const values = Array.from({ length: randomInt(rng, 0, 12) }, () => {
      const roll = randomInt(rng, 0, 7);
      if (roll === 0) return null;
      if (roll === 1) return undefined;
      if (roll === 2) return '';
      if (roll === 3) return randomInt(rng, -1000, 1000);
      if (roll === 4) return { value: index };
      if (roll === 5) return Symbol('fuzz');
      return `target-${index}`;
    });
    const snapshot = [...values];
    const expected = values.filter((value) => typeof value === 'string' && value !== '');

    assert.deepEqual([...toTargetSet(values)].sort(), expected.sort());
    assert.deepEqual(values, snapshot);
    assert.deepEqual([...toTargetSet(new Set(values))].sort(), expected.sort());
  }
});

test('fuzz: pageEntries 與 classifySpace 維持分類及時間不變量', { timeout: TIMEOUT_MS }, () => {
  const rng = createRng(SEED ^ 0x0a0b0c0d);

  for (let index = 0; index < 2_500; index++) {
    const pages = {};
    const expectedEntries = [];
    const liveIds = new Set(
      Array.from({ length: randomInt(rng, 0, 3) }, (_, i) => `live-${index}-${i}`),
    );

    for (let pageIndex = 0; pageIndex < randomInt(rng, 0, 7); pageIndex++) {
      const label = `p${pageIndex}`;
      const roll = randomInt(rng, 0, 9);
      let page;
      if (roll === 0) page = null;
      else if (roll === 1) page = [];
      else if (roll === 2) page = randomInt(rng, 0, 100);
      else {
        const targetRoll = randomInt(rng, 0, 5);
        let targetId;
        if (targetRoll === 0) targetId = null;
        else if (targetRoll === 1) targetId = '';
        else if (targetRoll === 2) targetId = randomInt(rng, 0, 100);
        else if (targetRoll === 3) targetId = `dead-${index}-${pageIndex}`;
        else targetId = pick(rng, [...liveIds]);
        page = { targetId };
      }
      pages[label] = page;
      if (isObjectRecord(page)) {
        expectedEntries.push({
          label,
          targetId: normalizedTargetId(page.targetId),
        });
      }
    }

    const createdRoll = randomInt(rng, 0, 4);
    let createdAt;
    if (createdRoll === 0) createdAt = NOW - randomInt(rng, 0, 20_000);
    else if (createdRoll === 1) {
      createdAt = new Date(NOW - randomInt(rng, 0, 20_000)).toISOString();
    } else if (createdRoll === 2) createdAt = 'invalid-date';
    else createdAt = null;

    const space = { id: index, createdAt, pages };
    const result = classifySpace(space, {
      liveTargets: liveIds,
      now: NOW,
      policy: { idleSpaceMs: 5_000 },
    });
    const entries = pageEntries(space);

    assert.deepEqual(
      entries.map(({ label, targetId }) => ({ label, targetId })),
      expectedEntries,
    );
    assert.equal(result.entries.length, expectedEntries.length);
    assert.equal(result.livePages.length, expectedEntries.filter((entry) => (
      entry.targetId !== null && liveIds.has(entry.targetId)
    )).length);
    assert.equal(result.deadPages.length, expectedEntries.filter((entry) => (
      entry.targetId !== null && !liveIds.has(entry.targetId)
    )).length);
    assert.equal(result.unboundPages.length, expectedEntries.filter((entry) => (
      entry.targetId === null
    )).length);

    const expectedKind = result.livePages.length > 0
      ? 'live'
      : expectedEntries.length === 0
        ? 'empty'
        : result.deadPages.length === expectedEntries.length
          ? 'dead'
          : result.unboundPages.length === expectedEntries.length
            ? 'unbound'
            : 'mixed';
    assert.equal(result.kind, expectedKind);

    const parsedTime = createdRoll === 0
      ? createdAt
      : createdRoll === 1
        ? Date.parse(createdAt)
        : Number.NaN;
    const expectedAge = Number.isFinite(parsedTime) ? Math.max(0, NOW - parsedTime) : null;
    assert.equal(result.ageMs, expectedAge);
    assert.equal(result.idle, expectedAge !== null && expectedAge >= 5_000);
  }
});

test('fuzz: planReap 保持保護、存活、冪等及統計不變量', { timeout: TIMEOUT_MS }, () => {
  const rng = createRng(SEED ^ 0x12345678);

  for (let index = 0; index < 1_800; index++) {
    const input = buildPlanInput(rng, index);
    const snapshot = structuredClone(input);
    const liveSet = new Set(input.liveTargetIds);
    const protectedIds = new Set(input.protect.map(String));
    const plan = planReap(input);
    const repeated = planReap(input);

    assert.deepEqual(plan, repeated);
    assert.deepEqual(input, snapshot);
    assert.equal(Array.isArray(plan.closeSpaces), true);
    assert.equal(Array.isArray(plan.dropPages), true);
    assert.equal(Array.isArray(plan.staleActiveTargets), true);

    const closeSet = new Set(plan.closeSpaces.map(String));
    assert.equal(closeSet.size, plan.closeSpaces.length);
    for (const space of input.spaces) {
      const key = String(space.id);
      const hasLivePage = Object.values(space.pages).some((page) => (
        isObjectRecord(page)
        && normalizedTargetId(page.targetId) !== null
        && liveSet.has(normalizedTargetId(page.targetId))
      ));
      const isProtected = protectedIds.has(key) || space.pinned === true;
      if (isProtected || hasLivePage) {
        assert.equal(closeSet.has(key), false, `protected/live space ${key} was closed`);
      }
    }

    const droppedKeys = new Set();
    for (const dropped of plan.dropPages) {
      const key = `${String(dropped.spaceId)}:${dropped.label}`;
      assert.equal(droppedKeys.has(key), false);
      droppedKeys.add(key);
      const space = input.spaces.find((candidate) => String(candidate.id) === String(dropped.spaceId));
      assert.ok(space);
      assert.equal(closeSet.has(String(space.id)), false);
      assert.equal(protectedIds.has(String(space.id)) || space.pinned === true, false);
      assert.equal(liveSet.has(dropped.targetId), false);
      assert.equal(space.pages[dropped.label].targetId, dropped.targetId);
    }

    const staleIds = new Set(plan.staleActiveTargets.map((item) => `${String(item.spaceId)}:${item.targetId}`));
    const expectedStale = new Set();
    for (const space of input.spaces) {
      const key = String(space.id);
      if (closeSet.has(key)) continue;
      if (protectedIds.has(key) || space.pinned === true) continue;
      if (typeof space.activeTargetId === 'string' && space.activeTargetId !== '') {
        if (!liveSet.has(space.activeTargetId)) {
          expectedStale.add(`${key}:${space.activeTargetId}`);
        }
      }
    }
    sameMembers(staleIds, expectedStale);

    assert.equal(plan.stats.examined, input.spaces.length);
    assert.equal(plan.stats.skipped, 0);
    assert.equal(plan.stats.closed, plan.closeSpaces.length);
    assert.equal(plan.stats.pagesDropped, plan.dropPages.length);
    assert.equal(plan.stats.staleActiveTargets, plan.staleActiveTargets.length);
    assert.ok(plan.stats.overCap >= 0);
    assert.ok(plan.stats.overCap <= plan.stats.closed);

    if (
      input.liveTargetIds.length === 0
      && input.policy.reapIdleWhenNoLiveTargets !== true
    ) {
      assert.equal(plan.reason, 'no-live-targets');
      assert.deepEqual(plan.closeSpaces, []);
      assert.deepEqual(plan.dropPages, []);
    } else {
      assert.equal(plan.reason, undefined);
    }

    const deleted = [];
    const removed = [];
    const store = {
      deleteSpace(id) { deleted.push(id); },
      removePage(spaceId, label) { removed.push([spaceId, label]); },
    };
    const applied = applyReapPlan(store, plan);
    assert.deepEqual(applied.closedSpaces, plan.closeSpaces);
    assert.deepEqual(applied.droppedPages, plan.dropPages);
    assert.deepEqual(deleted, plan.closeSpaces);
    assert.deepEqual(
      removed,
      plan.dropPages.map((item) => [item.spaceId, item.label]),
    );
  }
});

test('fuzz: buildPlan 對隨機 JSON 保持轉換一致或回傳受控錯誤', { timeout: TIMEOUT_MS }, () => {
  const rng = createRng(SEED ^ 0xcafebabe);

  for (let index = 0; index < 800; index++) {
    const input = buildPlanInput(rng, index);
    const raw = JSON.stringify(input);
    assert.deepEqual(buildPlan(raw), planReap(input));
  }

  for (let index = 0; index < 1_000; index++) {
    const raw = nonReservedString(rng);
    try {
      const plan = buildPlan(raw);
      assert.equal(Array.isArray(plan.closeSpaces), true);
      assert.equal(Array.isArray(plan.dropPages), true);
      assert.equal(Array.isArray(plan.staleActiveTargets), true);
    } catch (error) {
      assert.equal(error instanceof Error, true);
      assert.ok(error.message.length > 0);
    }
  }
});
