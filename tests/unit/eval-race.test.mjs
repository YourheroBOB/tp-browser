import test from 'node:test';
import assert from 'node:assert/strict';
import {
  raceEvalWithTimeout,
  truncateEvalResult,
  finalizeEvalResult,
  attachSaveAsPayload,
  truncateFetchResult,
  clampEvalTimeout,
  raceMouseAck,
  RESULT_MAX_BYTES,
  EVAL_TIMEOUT_MAX_MS,
} from '../../daemon/eval-race.js';

test('raceEvalWithTimeout handles the loser without unhandledRejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const work = new Promise((_, rej) => setTimeout(() => rej(new Error('late-cdp')), 40));
    await assert.rejects(() => raceEvalWithTimeout(work, 10), (e) => e.code === 'evalTimeout');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('raceEvalWithTimeout does not call onTimeout after a fast success', async () => {
  let fires = 0;
  const result = await raceEvalWithTimeout(Promise.resolve('fast-ok'), 300, () => { fires += 1; });
  assert.equal(result, 'fast-ok');
  assert.equal(fires, 0);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fires, 0, 'onTimeout must not fire after success');
});

test('raceEvalWithTimeout calls onTimeout only when work is still pending', async () => {
  let fires = 0;
  await assert.rejects(
    () => raceEvalWithTimeout(new Promise(() => {}), 20, () => { fires += 1; }),
    (e) => e.code === 'evalTimeout',
  );
  assert.equal(fires, 1);
});

test('truncateEvalResult marks oversized strings', () => {
  const big = 'x'.repeat(RESULT_MAX_BYTES + 10);
  const out = truncateEvalResult(big);
  assert.equal(out.__truncated, true);
  assert.ok(Buffer.byteLength(out.v, 'utf8') <= RESULT_MAX_BYTES);
  assert.equal(truncateEvalResult('ok'), 'ok');
});

test('truncateEvalResult does not split a multibyte character', () => {
  const snow = '雪';
  const bytes = Buffer.byteLength(snow, 'utf8');
  const count = Math.floor(RESULT_MAX_BYTES / bytes) + 2;
  const out = truncateEvalResult(snow.repeat(count));
  assert.equal(out.__truncated, true);
  assert.equal(out.v.includes('\uFFFD'), false);
  assert.ok(Buffer.byteLength(out.v, 'utf8') <= RESULT_MAX_BYTES);
});

test('saveAs payload over 1 MiB is not truncated and keeps b64', () => {
  const b64 = 'A'.repeat(RESULT_MAX_BYTES);
  const value = { status: 200, b64 };
  const truncated = truncateEvalResult(value);
  assert.equal(truncated.__truncated, true);
  assert.equal(truncated.b64, undefined);
  const kept = finalizeEvalResult(value, { truncate: false });
  assert.equal(kept.b64.length, RESULT_MAX_BYTES);
  const out = attachSaveAsPayload(kept, '/var/tmp/tp-saveas.bin');
  assert.equal(out.__b64.length, RESULT_MAX_BYTES);
  const sliced = truncateFetchResult({ status: 200, b64: 'B'.repeat(RESULT_MAX_BYTES + 8), body: 'ok' });
  assert.equal(sliced.b64.length, RESULT_MAX_BYTES + 8, 'truncateFetchResult must not slice b64');
});

test('clampEvalTimeout caps values that would overflow setTimeout', () => {
  assert.equal(clampEvalTimeout(2 ** 31), EVAL_TIMEOUT_MAX_MS);
  assert.equal(clampEvalTimeout(2 ** 31 + 5), EVAL_TIMEOUT_MAX_MS);
  assert.equal(clampEvalTimeout(0, 30000), 30000);
  assert.equal(clampEvalTimeout(-1, 30000), 30000);
  assert.equal(clampEvalTimeout(1500, 30000), 1500);
});

test('raceMouseAck throws on CDP error and returns timeout without throwing', async () => {
  await assert.rejects(
    () => raceMouseAck(Promise.reject(new Error('session closed')), 50, (ms) => new Promise((r) => setTimeout(r, ms))),
    /session closed/,
  );
  const raced = await raceMouseAck(new Promise(() => {}), 15, (ms) => new Promise((r) => setTimeout(r, ms)));
  assert.equal(raced, 'timeout');
  const ok = await raceMouseAck(Promise.resolve({}), 50, (ms) => new Promise((r) => setTimeout(r, ms)));
  assert.equal(ok, 'ok');
});
