// tests/fmb_w6_s03_keys_playwright_codes.test.mjs
// 回歸測試（fan-out 子任務 s03）：daemon/keys.js 檔頭宣稱支援 Playwright 相容鍵名，但
//   keyDescriptor('KeyA')／('Digit1')／('Minus') 全回 null，因此
//   parseChord('Control+KeyA')、parseChord('Digit1')、parseChord('Shift+Minus') 一律拋
//   unknown key；parseChord('ControlOrMeta') 也拋（keyDescriptor('ControlOrMeta') 回 null），
//   而 parseChord('Control') 卻能正常解析。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證。
// 檔名刻意不符合 daemon/keys.js 裡 isLegacyTestCall() 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 標準 Windows 虛擬鍵碼（OEM 標點 186–222）。
const OEM_KEYS = [
  ['Semicolon', ';', 186],
  ['Equal', '=', 187],
  ['Comma', ',', 188],
  ['Minus', '-', 189],
  ['Period', '.', 190],
  ['Slash', '/', 191],
  ['Backquote', '`', 192],
  ['BracketLeft', '[', 219],
  ['Backslash', '\\', 220],
  ['BracketRight', ']', 221],
  ['Quote', "'", 222],
];

test('題目點名的三個 chord 現在都能解析（修正前全拋 unknown key）', () => {
  assert.deepEqual(parseChord('Control+KeyA'), { modifiers: ['Control'], main: 'KeyA' });
  assert.deepEqual(parseChord('Digit1'), { modifiers: [], main: 'Digit1' });
  assert.deepEqual(parseChord('Shift+Minus'), { modifiers: ['Shift'], main: 'Minus' });
});

test('KeyA–KeyZ：key 為小寫字母、code 為原名、vk 65–90、text 為該字母', () => {
  [...LETTERS].forEach((upper, i) => {
    const name = `Key${upper}`;
    const lower = upper.toLowerCase();
    const d = keyDescriptor(name);
    assert.ok(d, `${name} 不可為 null`);
    assert.deepEqual(d, { key: lower, code: name, vk: 65 + i, text: lower }, `${name} 的描述子不正確`);
    // 共用查表：同一鍵名取兩次必須是同一個物件（不每次按鍵重新配置）
    assert.equal(keyDescriptor(name), d);
    // 可以單獨當主鍵，也可以當 chord 的主鍵
    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
    assert.deepEqual(parseChord(`Control+${name}`), { modifiers: ['Control'], main: name });
  });
});

test('Digit0–Digit9：key 為數字、code 為原名、vk 48–57、text 為該數字', () => {
  for (let i = 0; i < 10; i += 1) {
    const digit = String(i);
    const name = `Digit${digit}`;
    const d = keyDescriptor(name);
    assert.ok(d, `${name} 不可為 null`);
    assert.deepEqual(d, { key: digit, code: name, vk: 48 + i, text: digit }, `${name} 的描述子不正確`);
    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
    assert.deepEqual(parseChord(`Shift+${name}`), { modifiers: ['Shift'], main: name });
  }
});

test('OEM 標點鍵：code 為原名、vk 用標準值、key/text 為美式鍵盤字元', () => {
  for (const [name, ch, vk] of OEM_KEYS) {
    const d = keyDescriptor(name);
    assert.ok(d, `${name} 不可為 null`);
    assert.deepEqual(d, { key: ch, code: name, vk, text: ch }, `${name} 的描述子不正確`);
    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
  }
  // 題目明確點名的四個標準值
  assert.equal(keyDescriptor('Minus').vk, 189);
  assert.equal(keyDescriptor('Comma').vk, 188);
  assert.equal(keyDescriptor('Period').vk, 190);
  assert.equal(keyDescriptor('Slash').vk, 191);
});

test('ControlOrMeta 有具名鍵描述（等同 Control），修飾位元仍是 2', () => {
  const d = keyDescriptor('ControlOrMeta');
  assert.ok(d, "keyDescriptor('ControlOrMeta') 不可為 null");
  assert.deepEqual(d, keyDescriptor('Control'));
  assert.deepEqual(d, { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' });
  assert.equal(modifierBit('ControlOrMeta'), 2);
  // 可以單獨當主鍵，也可以繼續當 chord 的修飾鍵
  assert.deepEqual(parseChord('ControlOrMeta'), { modifiers: [], main: 'ControlOrMeta' });
  assert.deepEqual(parseChord('ControlOrMeta+KeyA'), { modifiers: ['ControlOrMeta'], main: 'KeyA' });
  assert.deepEqual(parseChord('ControlOrMeta+Shift+Minus'), {
    modifiers: ['ControlOrMeta', 'Shift'],
    main: 'Minus',
  });
});

test("查表維持 null-prototype + Object.hasOwn：parseChord('toString') 仍要丟 unknown key", () => {
  assert.throws(
    () => parseChord('toString'),
    (e) => e instanceof Error && e.message === 'unknown key "toString" in chord "toString"',
  );
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    assert.equal(keyDescriptor(name), null, `keyDescriptor(${JSON.stringify(name)}) 必須為 null`);
    assert.throws(
      () => parseChord(name),
      (e) => e instanceof Error && e.message === `unknown key "${name}" in chord "${name}"`,
      `${JSON.stringify(name)} 不可當主鍵`,
    );
  }
});

test('單一字元鍵與未知鍵名的既有行為不變', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('1'), { key: '1', code: 'Digit1', vk: 49, text: '1' });
  // 單字元標點仍沒有實體 code（只有以鍵名書寫時才拿得到）
  assert.deepEqual(keyDescriptor('-'), { key: '-', code: null, vk: 45, text: '-' });
  assert.equal(keyDescriptor('Enter').code, 'Enter');
  assert.equal(keyDescriptor('Space').code, 'Space');
  for (const name of ['Key', 'KeyAA', 'Keya', 'Digit', 'Digit10', 'minus', 'MinusLeft', 'NotAKey', 'F13']) {
    assert.equal(keyDescriptor(name), null, `${JSON.stringify(name)} 應為 null`);
  }
});
