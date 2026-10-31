// fmb_feature2/cli.test.js — 乾跑 CLI 的子程序測試（只餵 stdin、只讀 stdout/stderr）
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const NOW = Date.parse('2026-01-01T12:00:00.000Z');

const run = (input) =>
  spawnSync(process.execPath, [CLI], { input, encoding: 'utf8', timeout: 30_000 });

test('cli：有效輸入會印出回收計畫 JSON', () => {
  const payload = JSON.stringify({
    spaces: [
      { id: 1, createdAt: '2026-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-live' } } },
      { id: 2, createdAt: '2026-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-gone' } } },
    ],
    liveTargetIds: ['T-live'],
    now: NOW,
  });
  const res = run(payload);
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.deepEqual(plan.closeSpaces, [2]);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.examined, 2);
});

test('cli：空 live 集合會回報 no-live-targets 且不刪任何東西', () => {
  const res = run(JSON.stringify({ spaces: [{ id: 3, pages: { p1: { targetId: 'T-gone' } } }], liveTargetIds: [] }));
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
});

test('cli：非法 JSON 與空輸入皆以退出碼 2 結束', () => {
  const bad = run('this is not json');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid JSON input/);

  const empty = run('');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /usage:/);
});
