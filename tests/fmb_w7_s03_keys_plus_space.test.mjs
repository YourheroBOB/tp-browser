// tests/fmb_w7_s03_keys_plus_space.test.mjs
// 回歸測試（fan-out 子任務 s03 / 波次 w7）：daemon/keys.js 對 '+' 與 ' ' 主鍵的 chord 解析。
//
// 產品 bug：
//   parseChord('+') 拋 Error: empty key chord，keyboard.press('+') 因此失敗。
//   parseChord(' ') 同樣拋錯，因為每個片段都先 trim，空白鍵被當成空字串。
//   parseChord('Shift+ ') 回傳 { modifiers: [], main: 'Shift' }，空白鍵被靜默吞掉。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證。
// 檔名刻意不符合 daemon/keys.js 裡 isLegacyTestCall() 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, parseChord } from '../daemon/keys.js';

test("parseChord('+') 不再拋 empty key chord，主鍵就是 '+'", () => {
  assert.deepEqual(parseChord('+'), { modifiers: [], main: '+' });
  const d = keyDescriptor(parseChord('+').main);
  assert.ok(d, "keyDescriptor('+') 不得為 null");
  assert.deepEqual(d, { key: '+', code: null, vk: 43, text: '+' });
});

test("parseChord(' ') 的 main 是 ' '，且 keyDescriptor 不回 null", () => {
  assert.deepEqual(parseChord(' '), { modifiers: [], main: ' ' });
  const d = keyDescriptor(parseChord(' ').main);
  assert.ok(d, "keyDescriptor(' ') 不得為 null");
  assert.deepEqual(d, { key: ' ', code: 'Space', vk: 32, text: ' ' });
});

test("parseChord('Shift+ ') 解析為 Shift 修飾鍵 + 空白主鍵", () => {
  assert.deepEqual(parseChord('Shift+ '), { modifiers: ['Shift'], main: ' ' });
  assert.equal(isModifier(parseChord('Shift+ ').modifiers[0]), true);
  assert.equal(keyDescriptor(parseChord('Shift+ ').main).key, ' ');
});

test('舊語意維持：Control+、Control++a、Shift++、  a ', () => {
  assert.deepEqual(parseChord('Control+'), { modifiers: [], main: 'Control' });
  assert.deepEqual(parseChord('Control++a'), { modifiers: ['Control'], main: 'a' });
  assert.deepEqual(parseChord('Shift++'), { modifiers: ['Shift'], main: '+' });
  assert.deepEqual(parseChord('  a '), { modifiers: [], main: 'a' });
});

test('既有錯誤契約維持：空字串、全空白與包圍空白的 + 仍是 empty key chord', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord(' + '), /empty key chord/);
});
