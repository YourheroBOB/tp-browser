// tests/fmb_w6_s04_sdk_port_state.test.mjs
// lib/sdk.js 兩個回歸測試（零網路、零檔案讀寫、零真實憑證；token 一律用明顯假值）：
//
//  1.【回歸，修正前會失敗】createClient() 的 base URL。
//     修正前：`port === 9774 ? 9774 : 9772`。CLI（bin/ego-browser.js）依 TP_DAEMON_PORT
//     或 daemon.json 傳入自訂埠（例如 9780）時，CLI 的健康檢查打對了 daemon，
//     SDK 的 /rpc 與 /events 卻仍打 9772——連到另一個 daemon 或根本連不上。
//     修正後：傳入的合法埠直接生效，且 rpc 與 /events 共用同一個 base；
//     只有未提供或明顯不合法（0、負數、>65535、非整數、非數字字串）才回落 9772。
//
//  2.【回歸，修正前會失敗】page.waitForSelector() 的 state 驗證。
//     修正前：未知 state（例如把 visible 拼成 'visble'）在判斷式中落到 `false` 分支，
//     每一輪 probe 都「不成立」，一路輪詢到 timeout 才丟 TimeoutError，真正的錯因
//     （拼字錯誤）被吃掉，呼叫端白等 30 秒。
//     修正後：第一次 probe 之前就以 EgoError('InvalidArgumentError') 拒絕，且不發出 probe。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';

// 假 fetchImpl：/rpc 回固定 JSON；/events 回一條「立刻結束」的 SSE 串流（不連線）。
function spyFetch({ rpcResult = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/rpc')) {
      return { status: 200, ok: true, json: async () => ({ ok: true, result: rpcResult }) };
    }
    return {
      status: 200,
      ok: true,
      body: new ReadableStream({ pull(controller) { controller.close(); } }),
    };
  };
  return { calls, fetchImpl };
}

// 以假 rpc 驅動 buildSdk（不開串流、不連線）。
function makeSdk({ probe = () => ({ count: 1, visible: true }) } = {}) {
  const calls = [];
  const pages = [{ label: 'p1', targetId: 'T1' }];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') return { id: 7, name: 'w6-s04', ownership: 'agent', state: 'active', pages };
    if (method === 'page.call' && params.method === 'waitForSelectorProbe') return probe();
    return { ok: true };
  };
  const waitPush = () => { throw new Error('這個測試不該用到 waitPush'); };
  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace({ id: 7, name: 'w6-s04', ownership: 'agent', state: 'active', pages });
  return { sdk, space, calls };
}

const probes = (calls) => calls.filter((c) => c.method === 'page.call' && c.params.method === 'waitForSelectorProbe');

// ---- 重現一：自訂埠 --------------------------------------------------------

test('createClient({ port: 9780 }) 的 rpc 打 http://127.0.0.1:9780/rpc（修正前會打 9772）', async () => {
  const { calls, fetchImpl } = spyFetch({ rpcResult: { spaces: [] } });
  const client = createClient({ port: 9780, token: TOKEN, fetchImpl });

  assert.deepEqual(await client.rpc('space.list'), { spaces: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9780/rpc');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-ego-token'], TOKEN);
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 1, method: 'space.list', params: {} });
});

test('/events 與 rpc 共用同一個 base：自訂埠 9780 時打 http://127.0.0.1:9780/events', async () => {
  const { calls, fetchImpl } = spyFetch();
  const client = createClient({ port: 9780, token: TOKEN, fetchImpl });

  // 假串流立刻結束 → 等待者逾時；本測試只在乎它打的網址。
  await assert.rejects(
    client.waitPush(() => true, 30),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9780/events');
  assert.equal(calls[0].init.headers['x-ego-token'], TOKEN);
});

test('合法埠原樣使用；未提供或不合法才回落 9772', async () => {
  const cases = [
    [undefined, 'http://127.0.0.1:9772/rpc'],
    [9772, 'http://127.0.0.1:9772/rpc'],
    [9774, 'http://127.0.0.1:9774/rpc'],
    [9780, 'http://127.0.0.1:9780/rpc'],
    [18802, 'http://127.0.0.1:18802/rpc'],
    [0, 'http://127.0.0.1:9772/rpc'],
    [-1, 'http://127.0.0.1:9772/rpc'],
    [70000, 'http://127.0.0.1:9772/rpc'],
    [9772.5, 'http://127.0.0.1:9772/rpc'],
    ['', 'http://127.0.0.1:9772/rpc'],
    ['abc', 'http://127.0.0.1:9772/rpc'],
    [null, 'http://127.0.0.1:9772/rpc'],
  ];

  for (const [port, expected] of cases) {
    const { calls, fetchImpl } = spyFetch();
    await createClient({ port, token: TOKEN, fetchImpl }).rpc('space.list');
    assert.equal(calls.length, 1, `port=${String(port)}`);
    assert.equal(calls[0].url, expected, `port=${String(port)}`);
  }
});

// ---- 重現二：拼錯的 state --------------------------------------------------

test('waitForSelector 拼錯 state 會在 50ms 內以 InvalidArgumentError 拒絕，且完全不 probe', async () => {
  const { space, calls } = makeSdk();
  const page = space.page('p1');

  const t0 = Date.now();
  await assert.rejects(
    page.waitForSelector('#a', { state: 'visble' }),
    (e) => e instanceof EgoError
      && e.name === 'InvalidArgumentError'
      && /visble/.test(e.message)
      && /visible/.test(e.message),
  );
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 50, `應在 50ms 內拒絕，實際 ${elapsed}ms`);
  assert.equal(probes(calls).length, 0, '不合法 state 不該送出任何 waitForSelectorProbe');
});

test('其他未知 state（含大小寫錯誤、空字串、null）同樣在 probe 前被擋下', async () => {
  for (const state of ['vsible', 'Visible', 'detachedd', '', null]) {
    const { space, calls } = makeSdk();
    const page = space.page('p1');

    await assert.rejects(
      page.waitForSelector('#a', { state, timeout: 30 }),
      (e) => e instanceof EgoError && e.name === 'InvalidArgumentError',
      `state=${String(state)}`,
    );
    assert.equal(probes(calls).length, 0, `state=${String(state)} 不該 probe`);
  }
});

test('合法 state 行為不變：visible 第一輪成立並只 probe 一次', async () => {
  const { space, calls } = makeSdk({ probe: () => ({ count: 1, visible: true }) });
  const page = space.page('p1');

  const probe = await page.waitForSelector('#a', { timeout: 200 });
  assert.deepEqual(probe, { count: 1, visible: true });
  assert.equal(probes(calls).length, 1);
  assert.deepEqual(probes(calls)[0].params.args, ['#a', { state: 'visible' }]);
});
