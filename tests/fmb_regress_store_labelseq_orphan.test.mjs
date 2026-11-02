// 回歸：deleteSpace 必須一併清掉該空間的 labelSeq，否則回收器每收一個空間就留一筆孤兒計數。
// nextLabel 只認 labelSeq 的自有鍵，手編的數字字串要能續號，未知空間不得寫出孤兒序號。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import { applyReapPlan, planReap } from '../fmb_feature2/reaper.js';

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-labelseq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  return { file, store: new Store(file) };
}

function persisted(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('deleteSpace 清掉該空間的 labelSeq 並保留其他空間', (t) => {
  const { file, store } = openStore(t);
  const alpha = store.create({ name: 'alpha' });
  const beta = store.create({ name: 'beta' });
  assert.equal(store.nextLabel(alpha.id), 'p2');

  store.deleteSpace(alpha.id);
  const raw = persisted(file);
  assert.equal(Object.hasOwn(raw.spaces, String(alpha.id)), false);
  assert.equal(Object.hasOwn(raw.labelSeq, String(alpha.id)), false);
  assert.equal(raw.labelSeq[String(beta.id)], 1);
  assert.equal(store.get(alpha.id), null);
  assert.equal(store.get(beta.id).name, 'beta');
});

test('deleteSpace 在 labelSeq 為 null 時不拋錯', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 'alpha' });
  store.data.labelSeq = null;
  assert.doesNotThrow(() => store.deleteSpace(space.id));
  assert.equal(store.get(space.id), null);
});

test('deleteSpace 刪除未知 id 時保留既有帳本', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 'alpha' });
  assert.doesNotThrow(() => store.deleteSpace('does-not-exist'));
  const raw = persisted(file);
  assert.equal(raw.spaces[String(space.id)].name, 'alpha');
  assert.equal(raw.labelSeq[String(space.id)], 1);
});

test('nextLabel 忽略原型鏈上的計數器', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 'alpha' });
  const proto = {};
  proto[space.id] = 50;
  store.data.labelSeq = Object.create(proto);

  assert.equal(store.nextLabel(space.id), 'p2');
  assert.equal(Object.hasOwn(store.data.labelSeq, String(space.id)), true);
  assert.equal(store.data.labelSeq[space.id], 2);
  assert.equal(persisted(file).labelSeq[String(space.id)], 2);
});

test('nextLabel 接受手編帳本裡的數字字串計數器', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 'alpha' });
  store.data.labelSeq[space.id] = '4';
  assert.equal(store.nextLabel(space.id), 'p5');
  assert.equal(store.data.labelSeq[space.id], 5);
});

test('nextLabel 在 labelSeq 為 null 時補上空物件而不是拋錯', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 'alpha' });
  store.data.labelSeq = null;
  assert.equal(store.nextLabel(space.id), 'p2');
  assert.equal(store.data.labelSeq[space.id], 2);
  assert.equal(Array.isArray(store.data.labelSeq), false);
});

test('nextLabel 對未知空間不寫入孤兒序號', (t) => {
  const { file, store } = openStore(t);
  assert.equal(store.nextLabel('toString'), 'p?');
  assert.equal(store.nextLabel(99), 'p?');
  assert.equal(Object.hasOwn(store.data.labelSeq, 'toString'), false);
  assert.equal(Object.hasOwn(store.data.labelSeq, '99'), false);
  assert.equal(existsSync(file), false);
});

test('applyReapPlan 回收死亡空間後不留下孤兒 labelSeq', (t) => {
  const { file, store } = openStore(t);
  const dead = store.create({ name: 'dead' });
  const live = store.create({ name: 'live' });
  store.bindPage(dead.id, 'p1', 'T-gone');
  store.bindPage(live.id, 'p1', 'T-live');

  const plan = planReap({
    spaces: store.list(),
    liveTargetIds: ['T-live'],
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    policy: { reapDeadSpaces: true },
  });
  assert.equal(plan.reason, undefined);
  assert.equal(plan.stats.closed, 1);
  assert.equal(plan.stats.live, 1);
  assert.deepEqual(plan.closeSpaces.map(String), [String(dead.id)]);

  applyReapPlan(store, plan);
  const raw = persisted(file);
  assert.equal(raw.spaces[String(dead.id)], undefined);
  assert.equal(Object.hasOwn(raw.labelSeq, String(dead.id)), false);
  assert.equal(raw.labelSeq[String(live.id)], 1);
  assert.equal(raw.spaces[String(live.id)].pages.p1.targetId, 'T-live');
  assert.equal(raw.spaces[String(live.id)].name, 'live');
});
