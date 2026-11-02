// tests/fmb_w12_s02_cli_nodejs_empty_script.test.mjs
// 回歸測試：`tp-browser nodejs -e ''`（shell 引號漏掉、或 `-e "$VAR"` 變數展開失敗）過去會
// 執行一個空腳本並以 exit 0 結束，呼叫端因此誤判「任務已執行」——這與 `tp-browser nodejs -e`
// （整個參數漏掉）是同一個病灶，但舊驗證只擋了漏參數那一半。
//
// 本測試完全採用 in-process 純函式驗證 nodeJsArgsError()：
//   - 零子程序（不 spawn 任何行程，杜絕與平行執行的 tp-stop / Chrome 測試產生任何行程競爭）
//   - 零網路（不監聽任何埠位）
//   - 零檔案系統副作用
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeJsArgsError } from '../bin/tp-browser.js';

test('nodeJsArgsError：-e 收到空字串／純空白／只有 BOM 一律視為空腳本並回報錯誤', () => {
  for (const code of ['', '   ', '\n\t ', '\uFEFF', '\uFEFF  \n', '\r\n\t']) {
    const lines = nodeJsArgsError(['-e', code]);
    assert.ok(Array.isArray(lines), `code=${JSON.stringify(code)} 應被視為空腳本`);
    assert.equal(lines.length, 2, `code=${JSON.stringify(code)}`);
    assert.match(lines[0], /empty script/, `code=${JSON.stringify(code)}`);
    assert.match(lines[0], /nothing was executed/, `code=${JSON.stringify(code)}`);
    assert.match(lines[1], /pass real code/, `code=${JSON.stringify(code)}`);
  }
});

test('nodeJsArgsError：不該誤擋——有效腳本、只含註解、多餘參數、帶 BOM 的有效腳本', () => {
  assert.equal(nodeJsArgsError(['-e', 'console.log(1)']), null);
  assert.equal(nodeJsArgsError(['-e', 'console.log(1)', 'extra']), null);
  assert.equal(nodeJsArgsError(['-e', '// 只有註解也算有效腳本']), null);
  assert.equal(nodeJsArgsError(['-e', '/* multi-line comment */']), null);
  // BOM 後面有真實程式碼時不應被當成空腳本，BOM 剝除交由 runNodeJs 處理
  assert.equal(nodeJsArgsError(['-e', '\uFEFFconsole.log(2)']), null);
});

test('nodeJsArgsError：非 flag 的第一個參數與無參數仍維持走 stdin 舊路徑（回傳 null）', () => {
  assert.equal(nodeJsArgsError([]), null);
  assert.equal(nodeJsArgsError(['ignored-by-design']), null);
  assert.equal(nodeJsArgsError(['script.js']), null);
});

test('nodeJsArgsError：既有驗證不回歸（-e 漏參數、非字串）', () => {
  const missing = nodeJsArgsError(['-e']);
  assert.ok(Array.isArray(missing));
  assert.equal(missing.length, 2);
  assert.match(missing[0], /-e requires a script string/);
  assert.match(missing[1], /nothing was executed/);

  const nonString = nodeJsArgsError(['-e', 123]);
  assert.ok(Array.isArray(nonString));
  assert.match(nonString[0], /-e requires a script string/);

  const nullParam = nodeJsArgsError(['-e', null]);
  assert.ok(Array.isArray(nullParam));
  assert.match(nullParam[0], /-e requires a script string/);
});

test('nodeJsArgsError：既有驗證不回歸（未知旗標）', () => {
  for (const flag of ['--eval', '-x', '--help', '-v', '--version']) {
    const lines = nodeJsArgsError([flag, 'console.log(1)']);
    assert.ok(Array.isArray(lines), `flag=${flag}`);
    assert.equal(lines.length, 2, `flag=${flag}`);
    assert.match(lines[0], new RegExp(`unknown option ${flag}`), `flag=${flag}`);
    assert.match(lines[0], /only -e is supported/, `flag=${flag}`);
    assert.match(lines[1], /usage: tp-browser nodejs/, `flag=${flag}`);
  }
});
