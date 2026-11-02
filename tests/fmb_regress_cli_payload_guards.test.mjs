// 回歸：fmb_feature2/cli.js buildPlan 拒絕非物件 payload，且 now 只接受 number。
// 字串 now 若被強制轉型，下面這個未來空間會被誤判為閒置而回收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../fmb_feature2/cli.js';

const cli = join(fileURLToPath(new URL('..', import.meta.url)), 'fmb_feature2', 'cli.js');

function runCli(input) {
  return spawnSync(process.execPath, [cli], {
    input,
    encoding: 'utf8',
  });
}

test('陣列與 null payload 被拒絕，CLI 退出碼為 2', () => {
  assert.throws(() => buildPlan('[]'), /payload must be a JSON object/);
  assert.throws(() => buildPlan('null'), /payload must be a JSON object/);

  for (const input of ['[]', 'null']) {
    const result = runCli(input);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /payload must be a JSON object/);
    assert.equal(result.stdout, '');
  }
});

test('省略 spaces 或 liveTargetIds 為 null 時不丟錯', () => {
  const omitted = buildPlan(JSON.stringify({ liveTargetIds: ['T-live'] }));
  assert.deepEqual(omitted.closeSpaces, []);
  assert.equal(omitted.stats.examined, 0);

  const noLive = buildPlan(JSON.stringify({ spaces: [], liveTargetIds: null }));
  assert.equal(noLive.reason, 'no-live-targets');
  assert.deepEqual(noLive.closeSpaces, []);
});

test('now 為數字字串時不當成時間戳；真正的 number 才會讓未來空間閒置回收', () => {
  const later = Date.parse('2999-06-01T00:00:00.000Z');
  const base = {
    spaces: [{
      id: 1,
      name: 'future',
      createdAt: '2999-01-01T00:00:00.000Z',
      pages: { p1: { targetId: null } },
    }],
    liveTargetIds: ['T-live'],
    policy: { idleSpaceMs: 1000, reapDeadSpaces: false },
  };

  const ignored = buildPlan(JSON.stringify({ ...base, now: String(later) }));
  assert.deepEqual(ignored.closeSpaces, []);

  const honored = buildPlan(JSON.stringify({ ...base, now: later }));
  assert.deepEqual(honored.closeSpaces, [1]);
});
