// tests/fmb_w3_s03_keys_unicode.test.mjs
// 回歸測試（fan-out 子任務 s03）：daemon/keys.js 的鍵名對照對「非 ASCII 單一字元」與空白的處理。
//
// 三個產品 bug：
//   1. keyDescriptor('é') 的 text 是 undefined（只有 /[ -~]/ 才給 text），
//      導致 keyboard.press('é')／press('ü') 只送出沒有文字的 keyDown，頁面什麼都沒輸入。
//   2. keyDescriptor('😀') 因為代理對的 length 是 2 而回傳 null，parseChord('😀') 因此拋 unknown key。
//   3. keyDescriptor(' ') 的 code 是 null，與具名鍵 Space（code 'Space'）不一致。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；檔名刻意不符合 isLegacyTestCall 的正規式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

test("非 ASCII 單一字元要帶 text（'é'.text === 'é'、'中'.text === '中'）", () => {
  for (const c of ['é', 'ü', '中', 'Ω', 'ñ']) {
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子，不能是 null`);
    assert.equal(d.key, c);
    assert.equal(d.text, c, `${JSON.stringify(c)} 必須帶 text，否則 press 不會輸入任何字`);
  }
  assert.equal(keyDescriptor('é').text, 'é');
  assert.equal(keyDescriptor('中').text, '中');
});

test('emoji（代理對）不再是未知鍵，且帶完整 text', () => {
  const d = keyDescriptor('😀');
  assert.notEqual(d, null, "keyDescriptor('😀') 不可為 null");
  assert.equal(d.key, '😀');
  assert.equal(d.text, '😀');
  assert.equal(d.code, null, 'emoji 沒有對應的實體按鍵碼');
  assert.equal(typeof d.vk, 'number');
});

test('parseChord 接受非 ASCII 主鍵（含修飾鍵）', () => {
  assert.deepEqual(parseChord('Shift+é'), { modifiers: ['Shift'], main: 'é' });
  assert.deepEqual(parseChord('Control+中'), { modifiers: ['Control'], main: '中' });
  assert.deepEqual(parseChord('😀'), { modifiers: [], main: '😀' });
  // 解析後拿描述子補 CDP 欄位時，text 必須真的存在
  assert.equal(keyDescriptor(parseChord('Shift+é').main).text, 'é');
});

test("keyDescriptor(' ') 的 code 與具名鍵 Space 一致", () => {
  const space = keyDescriptor(' ');
  assert.equal(space.key, ' ');
  assert.equal(space.code, 'Space');
  assert.equal(space.vk, 32);
  assert.equal(space.text, ' ');
  assert.equal(space.code, keyDescriptor('Space').code);
});

test('控制字元不帶 text（含 \\u0007、\\n、\\t、\\u0000、\\u007f）', () => {
  for (const c of ['\u0007', '\n', '\r', '\t', '\u0000', '\u007f']) {
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 仍應有描述子`);
    assert.equal(d.text, undefined, `${JSON.stringify(c)} 不可帶 text`);
  }
});

test('ASCII 字母、數字、符號與既有具名鍵行為不變', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
  assert.deepEqual(keyDescriptor('+'), { key: '+', code: null, vk: 43, text: '+' });
  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.deepEqual(keyDescriptor('Space'), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  assert.equal(keyDescriptor('F1').vk, 112);
  assert.equal(keyDescriptor('F1').text, undefined);

  // 未知／多字元鍵仍回 null；非字串輸入仍丟 TypeError（呼叫端契約不變）
  assert.equal(keyDescriptor('NotAKey'), null);
  assert.equal(keyDescriptor('ab'), null);
  assert.equal(keyDescriptor(''), null);
  assert.throws(() => keyDescriptor(undefined), TypeError);
  assert.throws(() => keyDescriptor(null), TypeError);
});
