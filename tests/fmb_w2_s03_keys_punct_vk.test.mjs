// tests/fmb_w2_s03_keys_punct_vk.test.mjs
// 回歸測試（fan-out 波次 w2 子任務 s03）：daemon/keys.js 的標點字元必須依 US 鍵盤配置
// 對到「實體按鍵」的 Windows virtual-key code 與 code，不得再拿 charCodeAt() 充當 vk。
//
// 重現的產品 bug：
//   keyDescriptor('.').vk === 46（與 VK_DELETE 相同）、'-' === 45（VK_INSERT）、
//   '#' === 35（VK_END）、'$' === 36（VK_HOME）、'%' === 37（VK_LEFT）、
//   '(' === 40（VK_DOWN），而且 code 全是 null；因此在 input 裡 keyboard.press('.')
//   的 keydown 會被 Chrome 當成 Delete 處理。
// 另一個 bug：keyDescriptor(undefined) 讀 undefined.length 會丟 TypeError，應回 null。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor } from '../daemon/keys.js';

// US 鍵盤配置：字元 -> [期望 code, 期望 vk]
// 需要 Shift 的符號對到其基底鍵的 vk 與 code，key／text 仍保留原字元。
const EXPECTED = Object.assign(Object.create(null), {
  // 數字列
  '!': ['Digit1', 49],
  '@': ['Digit2', 50],
  '#': ['Digit3', 51],
  '$': ['Digit4', 52],
  '%': ['Digit5', 53],
  '^': ['Digit6', 54],
  '&': ['Digit7', 55],
  '*': ['Digit8', 56],
  '(': ['Digit9', 57],
  ')': ['Digit0', 48],
  // 上排標點列
  '-': ['Minus', 189],
  '_': ['Minus', 189],
  '=': ['Equal', 187],
  '+': ['Equal', 187],
  '[': ['BracketLeft', 219],
  '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '}': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  '|': ['Backslash', 220],
  ';': ['Semicolon', 186],
  ':': ['Semicolon', 186],
  "'": ['Quote', 222],
  '"': ['Quote', 222],
  ',': ['Comma', 188],
  '<': ['Comma', 188],
  '.': ['Period', 190],
  '>': ['Period', 190],
  '/': ['Slash', 191],
  '?': ['Slash', 191],
  '`': ['Backquote', 192],
  '~': ['Backquote', 192],
});

// 具名鍵佔用的 33–46 這一段 vk：標點不得再撞進來。
const NAMED_VK = Object.assign(Object.create(null), {
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
});

test('每個可列印 ASCII 標點都對到 US 鍵盤的實體按鍵（vk＋code，key／text 保留原字元）', () => {
  for (const [ch, [code, vk]] of Object.entries(EXPECTED)) {
    const d = keyDescriptor(ch);
    assert.ok(d, `${JSON.stringify(ch)} 必須有描述子`);
    assert.equal(d.key, ch, `${JSON.stringify(ch)}.key 必須保留原字元`);
    assert.equal(d.text, ch, `${JSON.stringify(ch)}.text 必須保留原字元`);
    assert.equal(d.code, code, `${JSON.stringify(ch)} 的 code`);
    assert.equal(d.vk, vk, `${JSON.stringify(ch)} 的 vk`);
    // 舊版就是把 charCodeAt() 當 vk，這裡明確排除，避免回歸。
    assert.notEqual(d.vk, ch.charCodeAt(0), `${JSON.stringify(ch)} 不可再拿 charCode 當 vk`);
  }
});

test('32 個可列印 ASCII 標點全數覆蓋（不多不少）', () => {
  const expected = [];
  for (let cp = 0x21; cp <= 0x7e; cp += 1) {
    const c = String.fromCharCode(cp);
    if (!/[A-Za-z0-9]/.test(c)) expected.push(c);
  }
  assert.equal(expected.length, 32);
  assert.deepEqual(Object.keys(EXPECTED).sort(), expected.sort());
});

test('標點不再與 Delete／Insert／End／Home／方向鍵共用 vk', () => {
  for (const ch of Object.keys(EXPECTED)) {
    const vk = keyDescriptor(ch).vk;
    for (const [named, namedVk] of Object.entries(NAMED_VK)) {
      assert.notEqual(vk, namedVk, `${JSON.stringify(ch)} 的 vk ${vk} 撞到 ${named}`);
    }
  }
  // 具名鍵本身必須維持原值（不可為了避撞而改壞既有對照）
  for (const [named, namedVk] of Object.entries(NAMED_VK)) {
    assert.equal(keyDescriptor(named).vk, namedVk, `${named}.vk 必須維持 ${namedVk}`);
  }
  assert.equal(keyDescriptor('Delete').vk, 46);
  assert.equal(keyDescriptor('Insert').vk, 45);
});

test('所有可列印 ASCII 標點的 vk 都不落在 33–46，且 code 為非空字串', () => {
  for (let cp = 0x21; cp <= 0x7e; cp += 1) {
    const c = String.fromCharCode(cp);
    if (/[A-Za-z0-9]/.test(c)) continue;
    const d = keyDescriptor(c);
    assert.ok(d, `標點 ${JSON.stringify(c)} 必須有描述子`);
    assert.ok(Number.isInteger(d.vk), `${JSON.stringify(c)}.vk 必須是整數`);
    assert.ok(d.vk < 33 || d.vk > 46, `${JSON.stringify(c)}.vk=${d.vk} 落在具名鍵區間 33–46`);
    assert.equal(typeof d.code, 'string', `${JSON.stringify(c)}.code 必須是字串`);
    assert.ok(d.code.length > 0, `${JSON.stringify(c)}.code 不得為空`);
  }
});

test('重現案例的 vk 已修正（46/45/35/36/37/40 的來源字元）', () => {
  const cases = { '.': 190, '-': 189, '#': 51, '$': 52, '%': 53, '(': 57 };
  for (const [ch, vk] of Object.entries(cases)) {
    const d = keyDescriptor(ch);
    assert.equal(d.vk, vk, `${JSON.stringify(ch)}.vk`);
    assert.notEqual(d.code, null, `${JSON.stringify(ch)}.code 不可再是 null`);
  }
});

test('非字串輸入一律回 null（不再因讀 undefined.length 丟 TypeError）', () => {
  const values = [undefined, null, 0, 5, 46, true, false, {}, [], () => {}, Symbol('fake')];
  for (const value of values) {
    assert.equal(keyDescriptor(value), null, `keyDescriptor(${String(value)}) 必須為 null`);
  }
  assert.equal(keyDescriptor(undefined), null);
  assert.equal(keyDescriptor(5), null);
  // 不可因此吞掉合法輸入
  assert.ok(keyDescriptor('a'));
  assert.ok(keyDescriptor('.'));
});

test('既有推導路徑不回歸：字母／數字／空白／非 ASCII／具名鍵', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });

  // 空白不是標點，維持既有行為（vk 32、無實體 code）
  const space = keyDescriptor(' ');
  assert.equal(space.vk, 32);
  assert.equal(space.code, null);
  assert.equal(space.text, ' ');

  // 非 ASCII 仍不帶 text
  const cjk = keyDescriptor('中');
  assert.equal(cjk.code, null);
  assert.equal(cjk.vk, '中'.charCodeAt(0));
  assert.equal(cjk.text, undefined);

  // 具名鍵不受影響
  assert.deepEqual(keyDescriptor('Delete'), { key: 'Delete', code: 'Delete', vk: 46 });
  assert.equal(keyDescriptor('Enter').vk, 13);
  assert.equal(keyDescriptor('F12').vk, 123);

  // 未知鍵名仍回 null
  assert.equal(keyDescriptor('NotAKey'), null);
  assert.equal(keyDescriptor('ab'), null);
  assert.equal(keyDescriptor(''), null);
});

test('同一字元永遠拿到同一個描述子物件（不必每次按鍵重新配置）', () => {
  for (const ch of Object.keys(EXPECTED)) {
    assert.equal(keyDescriptor(ch), keyDescriptor(ch), `${JSON.stringify(ch)} 的描述子必須穩定`);
  }
});
