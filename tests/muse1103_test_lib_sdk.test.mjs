// tests/muse1103_test_lib_sdk.test.mjs
// lib/sdk.js 尚未覆蓋的邊界／錯誤路徑 focused tests。
// 全程零網路、零檔案讀寫、零真實憑證：只用假的 fetchImpl／rpc／waitPush。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

// ---- createClient: base / port -------------------------------------------

function rpcRecorder(result = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchImpl };
}

test('字串埠（含前後空白）直接生效；非數字字串回落 9772', async () => {
  for (const [port, expected] of [
    ['9780', 'http://127.0.0.1:9780/rpc'],
    ['  9780  ', 'http://127.0.0.1:9780/rpc'],
    ['9774', 'http://127.0.0.1:9774/rpc'],
    ['abc', 'http://127.0.0.1:9772/rpc'],
    ['', 'http://127.0.0.1:9772/rpc'],
    ['9772.5', 'http://127.0.0.1:9772/rpc'],
    ['0x10', 'http://127.0.0.1:9772/rpc'],
  ]) {
    const { calls, fetchImpl } = rpcRecorder();
    await createClient({ port, token: TOKEN, fetchImpl }).rpc('space.list');
    assert.equal(calls[0].url, expected, `port=${JSON.stringify(port)}`);
  }
});

test('waitPush 逾時錯誤訊息格式：`<message> timed out after <timeout>ms`', async () => {
  const { fetchImpl } = rpcRecorder();
  // fetchImpl 的 /rpc 分支會被 startEvents 的 /events 呼叫打到：回一個立刻結束的串流。
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/events')) {
        return { status: 200, ok: true, body: new ReadableStream({ pull(c) { c.close(); } }) };
      }
      return { status: 200, ok: true, json: async () => ({ ok: true, result: null }) };
    },
  });
  await assert.rejects(
    client.waitPush(() => false, 30, 'page.waitForEvent(\'popup\')'),
    (e) => e instanceof EgoError && e.name === 'TimeoutError'
      && e.message === 'page.waitForEvent(\'popup\') timed out after 30ms',
  );
});

test('fetch 直接拋錯（斷線）：等待者逾時而非把底層錯誤外洩，且下次 waitPush 重試 /events', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), /\/events$/);
    throw new Error('connection refused');
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });
  await assert.rejects(
    client.waitPush(() => true, 30),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
  assert.equal(calls, 1);
  await assert.rejects(client.waitPush(() => true, 30), (e) => e.name === 'TimeoutError');
  assert.equal(calls, 2, '串流失敗後必須重新訂閱');
});

// ---- createClient: SSE 解析邊界 --------------------------------------------

function sseClient(chunks) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  return createClient({ port: 9772, token: TOKEN, fetchImpl: async () => ({ status: 200, ok: true, body }) });
}

const dataChunk = (msg) => `data: ${JSON.stringify(msg)}\n\n`;

test('SSE：一個訊息被切成兩段仍能重組', async () => {
  const raw = dataChunk({ type: 'push', kind: 'popup', payload: { targetId: 'T-9' } });
  const cut = Math.floor(raw.length / 2);
  const client = sseClient([raw.slice(0, cut), raw.slice(cut)]);
  const msg = await client.waitPush((m) => m.kind === 'popup', 2000);
  assert.equal(msg.payload.targetId, 'T-9');
});

test('SSE：壞掉的 JSON 行與非 data 區塊被跳過，後續合法推播仍可達', async () => {
  const client = sseClient([
    'data: {not json}\n\n',
    ': comment heartbeat\n\n',
    `notdata: hello\n\n${dataChunk({ type: 'push', kind: 'download', payload: { guid: 'g-2' } })}`,
  ]);
  const msg = await client.waitPush((m) => m.kind === 'download', 2000);
  assert.equal(msg.payload.guid, 'g-2');
});

// ---- buildSdk harness -------------------------------------------------------

function makeSdk({ pages, spaceUse } = {}) {
  const calls = [];
  const rows = pages ?? [{ label: 'p1', targetId: 'T1' }];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') {
      return spaceUse ? spaceUse() : { id: 7, name: 'demo', ownership: 'agent', state: 'active', pages: rows };
    }
    if (method === 'page.call') {
      if (params.method === 'url') return 'https://a.test/now';
      if (params.method === 'screenshot') return params.args?.[0]?.path ? { path: params.args[0].path } : 'b64blob';
      if (params.method === 'evaluate') return params.args?.[1];
      return { ok: true, method: params.method };
    }
    if (method === 'space.list') return [];
    if (method === 'space.tabs') return rows;
    if (method === 'space.create') return { id: 8, name: params.name, ownership: 'agent', state: 'active', pages: [] };
    return {};
  };
  const sdk = buildSdk({ rpc, waitPush: () => { throw new Error('不該用到 waitPush'); } });
  const space = new sdk.TaskSpace({ id: 7, name: 'demo', ownership: 'agent', state: 'active', pages: rows });
  return { sdk, space, calls };
}

const pageCalls = (calls, name) => calls.filter((c) => c.method === 'page.call' && (!name || c.params.method === name));

// ---- buildSdk：全域 helper --------------------------------------------------

test('gotoAndWait：timeout 秒／毫秒啟發式轉換與預設值', async () => {
  const { sdk, calls } = makeSdk();
  await sdk.gotoAndWait('https://a.test/', { timeout: 10 });
  await sdk.gotoAndWait('https://a.test/', { timeout: 500 });
  await sdk.gotoAndWait('https://a.test/');
  const gotos = pageCalls(calls, 'goto');
  assert.deepEqual(gotos[0].params.args, ['https://a.test/', { waitUntil: 'load', timeout: 10000 }]);
  assert.deepEqual(gotos[1].params.args, ['https://a.test/', { waitUntil: 'load', timeout: 500 }]);
  assert.deepEqual(gotos[2].params.args, ['https://a.test/', { waitUntil: 'load', timeout: 30000 }]);
});

test('click：陣列走 mouse.click，字串走 page click；fillInput/uploadFile 去掉 css: 前綴', async () => {
  const { sdk, calls } = makeSdk();
  await sdk.click([3, 4], { button: 'right' });
  await sdk.click('#btn');
  await sdk.fillInput('css:.name', 'bob');
  await sdk.uploadFile('css:input[type=file]', '/tmp/x.txt');
  const seq = calls.filter((c) => c.method === 'page.call').map((c) => [c.params.method, c.params.args]);
  assert.deepEqual(seq, [
    ['mouse.click', [3, 4, { button: 'right' }]],
    ['click', ['#btn', {}]],
    ['fill', ['.name', 'bob', {}]],
    ['setInputFiles', ['input[type=file]', '/tmp/x.txt']],
  ]);
});

test('taskSpace：數字／數字字串走 space.use；名稱先查 list，命中用既有、落空才 create', async () => {
  const { sdk, calls } = makeSdk();
  await sdk.taskSpace(7);
  await sdk.taskSpace('42');
  const uses = calls.filter((c) => c.method === 'space.use');
  assert.deepEqual(uses[0].params, { idOrName: 7 });
  assert.deepEqual(uses[1].params, { idOrName: 42 });

  // 名稱在 list 中不存在 → create；useOrCreateTaskSpace 是同一入口。
  const ts = await sdk.useOrCreateTaskSpace('brand-new');
  const created = calls.find((c) => c.method === 'space.create');
  assert.deepEqual(created.params, { name: 'brand-new' });
  assert.equal(ts.spaceId, 8);
});

test('completeTaskSpace：keep 為 false／空字串／null 都正規化成 []', async () => {
  const { sdk, calls } = makeSdk();
  await sdk.completeTaskSpace(7, { keep: false });
  await sdk.completeTaskSpace(7, { keep: '' });
  await sdk.completeTaskSpace(7, { keep: null });
  const finishes = calls.filter((c) => c.method === 'space.finish').map((c) => c.params);
  assert.deepEqual(finishes, [{ id: 7, keep: [] }, { id: 7, keep: [] }, { id: 7, keep: [] }]);
});

// ---- buildSdk：Page ----------------------------------------------------------

test('Keyboard.paste：字串直傳、物件取 text、null／undefined 變空字串', async () => {
  const { space, calls } = makeSdk();
  const page = space.page('p1');
  await page.keyboard.paste('hello');
  await page.keyboard.paste({ text: 'from-clip', html: '<b>from-clip</b>' });
  await page.keyboard.paste(null);
  await page.keyboard.paste(undefined);
  const texts = pageCalls(calls, 'keyboard.insertText').map((c) => c.params.args);
  assert.deepEqual(texts, [['hello'], ['from-clip'], [''], ['']]);
});

test('evaluate：undefined 參數轉成 null；字串原樣傳；eval 是別名', async () => {
  const { space, calls } = makeSdk();
  const page = space.page('p1');
  assert.equal(await page.evaluate('return 1'), null);
  assert.deepEqual(await page.evaluate((x) => x, { a: 1 }), { a: 1 });
  assert.equal(await page.eval('return 2', undefined), null);
  const evs = pageCalls(calls, 'evaluate').map((c) => c.params.args);
  assert.equal(evs[0][0], 'return 1');
  assert.equal(evs[0][1], null);
  assert.deepEqual(evs[1][1], { a: 1 });
});

test('text()：預設上限切片；evaluate 回空時回空字串', async () => {
  const { space } = makeSdk();
  const long = 'x'.repeat(200);
  const rpcLong = async (method, params = {}) => {
    if (method === 'page.call' && params.method === 'evaluate') return long;
    return {};
  };
  const sdkLong = buildSdk({ rpc: rpcLong, waitPush: () => { throw new Error('x'); } });
  const pLong = new sdkLong.TaskSpace({ id: 7, name: 'd', ownership: 'a', state: 'active', pages: [] }).page('p1');
  assert.equal((await pLong.text({ maxChars: 10 })).length, 10);

  const sdkNull = buildSdk({ rpc: async () => null, waitPush: () => { throw new Error('x'); } });
  const pNull = new sdkNull.TaskSpace({ id: 7, name: 'd', ownership: 'a', state: 'active', pages: [] }).page('p1');
  assert.equal(await pNull.text(), '');
});

test('screenshot：有 path 回 r.path，沒有回整個結果', async () => {
  const { space } = makeSdk();
  const page = space.page('p1');
  assert.equal(await page.screenshot({ path: '/tmp/shot.png' }), '/tmp/shot.png');
  assert.equal(await page.screenshot(), 'b64blob');
});

test('userPage：無分頁回 null；pages() 過濾掉沒有 label 的 tab', async () => {
  const empty = makeSdk({ pages: [] });
  assert.equal(await empty.space.userPage(), null);

  const { space } = makeSdk({ pages: [{ label: 'p1', targetId: 'T1' }, { targetId: 'T2' }] });
  const first = await space.userPage();
  assert.equal(first.label, 'p1');
  assert.equal(first.targetId, 'T1');
  const pages = await space.pages();
  assert.deepEqual(pages.map((p) => p.label), ['p1']);
});

test('waitForFunction：首輪成立只 probe 一次；一直不成立則 TimeoutError', async () => {
  const { space, calls } = makeSdk();
  const v = await space.page('p1').waitForFunction(() => true, undefined, { timeout: 500 });
  assert.ok(v);
  assert.equal(pageCalls(calls, 'waitForFunctionProbe').length, 1);

  const rpcFalsy = async (method, params = {}) => {
    if (method === 'page.call' && params.method === 'waitForFunctionProbe') return null;
    return {};
  };
  const sdkFalsy = buildSdk({ rpc: rpcFalsy, waitPush: () => { throw new Error('不該用到 waitPush'); } });
  const spaceFalsy = new sdkFalsy.TaskSpace({ id: 7, name: 'd', ownership: 'a', state: 'active', pages: [] });
  await assert.rejects(
    spaceFalsy.page('p1').waitForFunction(() => false, undefined, { timeout: 60, polling: 10 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError' && /waitForFunction timed out after 60ms/.test(e.message),
  );
});

test('waitForSelector：visible 遇 count 0 輪詢到逾時；waitForURL 未知 matcher 視為不符而逾時', async () => {
  const rpc = async (method, params = {}) => {
    if (method === 'page.call' && params.method === 'waitForSelectorProbe') return { count: 0, visible: false };
    if (method === 'page.call' && params.method === 'url') return 'https://a.test/x';
    return { id: 7, name: 'd', ownership: 'agent', state: 'active', pages: [{ label: 'p1', targetId: 'T1' }] };
  };
  const sdk = buildSdk({ rpc, waitPush: () => { throw new Error('不該用到 waitPush'); } });
  const space = new sdk.TaskSpace({ id: 7, name: 'd', ownership: 'agent', state: 'active', pages: [{ label: 'p1', targetId: 'T1' }] });
  await assert.rejects(
    space.page('p1').waitForSelector('#a', { state: 'visible', timeout: 40 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError' && /waiting for #a to be visible/.test(e.message),
  );
  await assert.rejects(
    space.page('p1').waitForURL(12345, { timeout: 40 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError' && /last: https:\/\/a\.test\/x/.test(e.message),
  );
});
