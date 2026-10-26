// Race a CDP evaluate against a safety timeout without leaving an unhandled rejection.

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function raceEvalWithTimeout(work, timeoutMs, onTimeout) {
  let timedOut = false;
  const guarded = Promise.resolve(work).then((v) => v, (e) => Promise.reject(e));
  guarded.catch(() => {});
  const timeoutP = sleep(timeoutMs).then(() => {
    timedOut = true;
    if (typeof onTimeout === 'function') {
      try { onTimeout(); } catch {}
    }
    const err = new Error('timeout');
    err.code = 'evalTimeout';
    throw err;
  });
  timeoutP.catch(() => {});
  try {
    return await Promise.race([guarded, timeoutP]);
  } catch (e) {
    if (timedOut || e?.code === 'evalTimeout' || /timed out/.test(String(e?.message || ''))) {
      const err = new Error('timeout');
      err.code = 'evalTimeout';
      throw err;
    }
    throw e;
  }
}

export const RESULT_MAX_BYTES = 1048576;

export function truncateEvalResult(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= RESULT_MAX_BYTES) return value;
    const sliced = Buffer.from(value, 'utf8').subarray(0, RESULT_MAX_BYTES).toString('utf8');
    return { __truncated: true, v: sliced };
  }
  let json;
  try { json = JSON.stringify(value); } catch { return value; }
  if (json == null) return value;
  if (Buffer.byteLength(json, 'utf8') <= RESULT_MAX_BYTES) return value;
  const preview = Buffer.from(json, 'utf8').subarray(0, RESULT_MAX_BYTES).toString('utf8');
  return { __truncated: true, preview };
}

export function truncateFetchResult(v) {
  if (!v || typeof v !== 'object') return v;
  if (typeof v.body === 'string' && Buffer.byteLength(v.body, 'utf8') > RESULT_MAX_BYTES) {
    v.body = Buffer.from(v.body, 'utf8').subarray(0, RESULT_MAX_BYTES).toString('utf8');
    v.truncated = true;
  }
  if (typeof v.b64 === 'string' && Buffer.byteLength(v.b64, 'utf8') > RESULT_MAX_BYTES) {
    v.b64 = v.b64.slice(0, RESULT_MAX_BYTES);
    v.truncated = true;
  }
  return v;
}
