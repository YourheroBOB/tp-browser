import test from 'node:test';
import assert from 'node:assert/strict';
import { raceEvalWithTimeout, truncateEvalResult, RESULT_MAX_BYTES } from '../../daemon/eval-race.js';

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

test('truncateEvalResult marks oversized strings', () => {
  const big = 'x'.repeat(RESULT_MAX_BYTES + 10);
  const out = truncateEvalResult(big);
  assert.equal(out.__truncated, true);
  assert.ok(Buffer.byteLength(out.v, 'utf8') <= RESULT_MAX_BYTES);
  assert.equal(truncateEvalResult('ok'), 'ok');
});
