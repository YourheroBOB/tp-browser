// 卡住的 GET /events 會讓後續 waitPush 不再訂閱。
// 修正前：第一次 fetch 永不回傳，等待者逾時後 sseStarted 仍為 true，
// 第二次 waitPush 不會再打 /events，只能再逾時。
// 修正後：最後一個等待者逾時會中止那條連線，下一次 waitPush 重新訂閱並收到推播。
// 全程假 fetch，不連網、不讀寫檔案、不使用真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

function sseStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

const dataChunk = (msg) => `data: ${JSON.stringify(msg)}\n\n`;
const okRes = (chunks) => ({ status: 200, ok: true, body: sseStream(chunks) });

test('卡住的 /events 逾時後，下一次 waitPush 會中止舊連線並重新訂閱', async () => {
  const seen = [];
  let releaseHung = () => {};
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), token: init?.headers?.['x-ego-token'] });
    if (seen.length === 1) {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          fn();
        };
        releaseHung = () => finish(() => resolve({ status: 200, ok: true, body: sseStream([]) }));
        const abort = () => finish(() => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
        const signal = init && init.signal;
        if (signal) {
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }
      });
    }
    return okRes([dataChunk({ type: 'push', kind: 'popup', payload: { targetId: 'T-2' } })]);
  };

  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });
  try {
    await assert.rejects(
      client.waitPush(() => true, 50),
      (e) => e instanceof EgoError && e.name === 'TimeoutError',
    );

    let msg;
    try {
      msg = await client.waitPush((m) => m.kind === 'popup', 1000);
    } catch (e) {
      assert.fail(`第二次 waitPush 應重新訂閱並收到推播，實際 ${e.name}: ${e.message}；/events 呼叫次數 ${seen.length}`);
    }
    assert.equal(seen.length, 2);
    assert.match(seen[1].url, /\/events$/);
    assert.equal(seen[1].token, TOKEN);
    assert.equal(msg.payload.targetId, 'T-2');
  } finally {
    releaseHung();
  }
});
