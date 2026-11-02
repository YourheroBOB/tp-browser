// tests/page_ops_restore_cookies_partial_failure.test.mjs
//
// 回歸測試（daemon/page-ops.js）：restoreVaultToBrowser() 把整份 cookie vault 一次丟給
// CDP Storage.setCookies。Chrome 對這個請求是「依序寫入、遇到第一筆它不接受的 cookie 就中止」，
// 所以排在那一筆後面的合法 cookie 一個都寫不進去；請求本身太大時（vault 動輒數千筆）也會整批失敗。
// 而舊版外層是空 catch，錯誤完全被吞掉。
// 使用者實際症狀：重啟（tp-stop / tp-start、systemd restart）後「一整票網站同時被登出」，
// 而不是只有那一筆有問題的 cookie 失效，且 daemon log 沒有任何痕跡。
//
// 零網路、零真實憑證、不讀寫任何磁碟路徑：用假的 cdp.send 模擬 Chrome 的失敗語意。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHub } from '../daemon/page-ops.js';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function cookie(name, domain, extra = {}) {
  return {
    name,
    value: 'FAKE_VALUE_FOR_TEST',
    domain,
    path: '/',
    expires: FUTURE,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    ...extra,
  };
}

// 刻意不走建構子：不啟計時器、不碰 ~/.local/share/ego-linux，只取用原型上的 restoreVaultToBrowser()。
function makeHub({ accepted, calls, partitionedSupported = false, maxBatch = Infinity }) {
  const hub = Object.create(BrowserHub.prototype);
  hub.cookieVault = new Map();
  hub.cdp = {
    send(method, params) {
      if (method !== 'Storage.setCookies') return Promise.resolve({});
      calls.push(params.cookies.map((c) => c.name));
      if (params.cookies.length > maxBatch) {
        return Promise.reject(new Error('Message too large'));
      }
      // 模擬 Chrome：逐筆寫入，遇到第一筆不合法的 cookie 就讓整個請求失敗
      // （此處以「瀏覽器不支援 CHIPS 分區 cookie」當成不合法的那一筆）。
      for (const c of params.cookies) {
        if (c.partitionKey && !partitionedSupported) {
          return Promise.reject(new Error('Invalid cookie fields'));
        }
        accepted.add(c.name);
      }
      return Promise.resolve();
    },
  };
  return hub;
}

function addCookies(hub, list) {
  for (const c of list) hub.cookieVault.set(`${c.name}|${c.domain}|${c.path}`, c);
}

test('restoreVaultToBrowser：一筆被 Chrome 拒絕的 cookie 不該讓其他合法 cookie 全部還原失敗', async () => {
  const accepted = new Set();
  const calls = [];
  const hub = makeHub({ accepted, calls });
  addCookies(hub, [
    cookie('tp_before', 'before.example'),
    cookie('tp_partitioned', 'partitioned.example', {
      sameSite: 'None',
      partitionKey: { topLevelSite: 'https://embed.example', hasCrossSiteAncestor: true },
    }),
    cookie('tp_after', 'after.example'),
  ]);

  await hub.restoreVaultToBrowser();

  // 修好前：批次請求在 tp_partitioned 就中止、被空 catch 吞掉，tp_after 永遠不會被寫入。
  assert.equal(accepted.has('tp_after'), true, '排在失敗 cookie 之後的合法 cookie 應在逐筆重試時還原');
  assert.equal(accepted.has('tp_before'), true, '排在失敗 cookie 之前的合法 cookie 仍應還原');
  assert.equal(accepted.has('tp_partitioned'), false, '不合法的那筆本來就寫不進去');
  assert.equal(calls.length, 4, '一次批次 + 三筆逐筆重試');
});

test('restoreVaultToBrowser：全部合法時仍是一次批次呼叫（不改變正常路徑）', async () => {
  const accepted = new Set();
  const calls = [];
  const hub = makeHub({ accepted, calls });
  addCookies(hub, [cookie('tp_a', 'a.example'), cookie('tp_b', 'b.example')]);

  await hub.restoreVaultToBrowser();

  assert.deepEqual(calls, [['tp_a', 'tp_b']]);
  assert.deepEqual([...accepted].sort(), ['tp_a', 'tp_b']);
});

test('restoreVaultToBrowser：全部被拒絕時安靜結束，不對呼叫端丟錯', async () => {
  const accepted = new Set();
  const calls = [];
  const hub = makeHub({ accepted, calls });
  addCookies(hub, [
    cookie('tp_only', 'only.example', {
      sameSite: 'None',
      partitionKey: { topLevelSite: 'https://embed.example', hasCrossSiteAncestor: false },
    }),
  ]);

  await assert.doesNotReject(() => hub.restoreVaultToBrowser());
  assert.equal(accepted.size, 0);
});

test('restoreVaultToBrowser：整批請求過大被拒絕時，逐筆重試仍能還原所有合法 cookie', async () => {
  const accepted = new Set();
  const calls = [];
  const hub = makeHub({ accepted, calls, maxBatch: 2 });
  addCookies(hub, [
    cookie('tp_1', 'one.example'),
    cookie('tp_2', 'two.example'),
    cookie('tp_3', 'three.example'),
  ]);

  await hub.restoreVaultToBrowser();

  // 修好前：3 筆的批次被拒（Message too large）→ 空 catch 吞掉 → 一個 cookie 都沒還原。
  assert.deepEqual([...accepted].sort(), ['tp_1', 'tp_2', 'tp_3']);
  assert.equal(calls.length, 4, '一次批次 + 三筆逐筆重試');
});
