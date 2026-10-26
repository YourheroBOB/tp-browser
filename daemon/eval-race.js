// Race a CDP evaluate against a safety timeout without leaving an unhandled rejection.
// Never fire onTimeout after the work has already settled.

export const RESULT_MAX_BYTES = 1048576;
export const EVAL_TIMEOUT_MAX_MS = 600000; // 10 min, well below setTimeout's 2^31-1 overflow

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clampEvalTimeout(ms, fallback = 30000) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), EVAL_TIMEOUT_MAX_MS);
}

export async function raceEvalWithTimeout(work, timeoutMs, onTimeout) {
  const ms = clampEvalTimeout(timeoutMs, 30000);
  let timedOut = false;
  let settled = false;
  let timer;
  const guarded = Promise.resolve(work);
  guarded.catch(() => {});
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (typeof onTimeout === 'function') {
        try { onTimeout(); } catch {}
      }
      const err = new Error('timeout');
      err.code = 'evalTimeout';
      reject(err);
    }, ms);
  });
  timeoutP.catch(() => {});
  try {
    const value = await Promise.race([guarded, timeoutP]);
    settled = true;
    return value;
  } catch (e) {
    settled = true;
    if (timedOut || e?.code === 'evalTimeout' || /timed out/.test(String(e?.message || ''))) {
      const err = new Error('timeout');
      err.code = 'evalTimeout';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function utf8Prefix(str, maxBytes) {
  const buf = Buffer.from(String(str), 'utf8');
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

export function truncateEvalResult(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= RESULT_MAX_BYTES) return value;
    return { __truncated: true, v: utf8Prefix(value, RESULT_MAX_BYTES) };
  }
  let json;
  try { json = JSON.stringify(value); } catch { return value; }
  if (json == null) return value;
  if (Buffer.byteLength(json, 'utf8') <= RESULT_MAX_BYTES) return value;
  return { __truncated: true, preview: utf8Prefix(json, RESULT_MAX_BYTES) };
}

export function finalizeEvalResult(value, { truncate = true } = {}) {
  return truncate ? truncateEvalResult(value) : value;
}

export function attachSaveAsPayload(v, saveAs) {
  if (!v || typeof v !== 'object') return v;
  if (saveAs && v.b64 !== null && v.b64 !== undefined) v.__b64 = v.b64;
  return v;
}

// Body text only. Never slice b64: that yields corrupt files if saveAs is used.
export function truncateFetchResult(v) {
  if (!v || typeof v !== 'object') return v;
  if (typeof v.body === 'string' && Buffer.byteLength(v.body, 'utf8') > RESULT_MAX_BYTES) {
    v.body = utf8Prefix(v.body, RESULT_MAX_BYTES);
    v.truncated = true;
  }
  return v;
}

export async function raceMouseAck(sent, timeoutMs, sleepFn = sleep) {
  let fail = null;
  const ack = Promise.resolve(sent).then(
    () => 'ok',
    (e) => { fail = e; return 'error'; },
  );
  const raced = await Promise.race([
    ack,
    Promise.resolve(sleepFn(timeoutMs)).then(() => 'timeout'),
  ]);
  if (raced === 'error') throw fail;
  return raced;
}
