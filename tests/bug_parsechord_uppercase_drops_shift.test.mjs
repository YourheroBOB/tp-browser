// parseChord 對 ASCII 大寫字母會漏掉 Shift：press('A') 的 key／text 已是 'A'，
// 修飾位元卻是 0，keydown 的 shiftKey 為 false。
// 純函式測試：不連網、不讀寫檔案、不啟動瀏覽器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

const bits = (chord) => parseChord(chord).modifiers.reduce((b, m) => b | modifierBit(m), 0);

test('單一大寫字母必須帶 Shift（位元 8），主鍵仍是該大寫字母', () => {
  assert.deepEqual(parseChord('A'), { modifiers: ['Shift'], main: 'A' });
  assert.deepEqual(parseChord('Z'), { modifiers: ['Shift'], main: 'Z' });
  assert.equal(bits('A'), 8);
  assert.equal(bits('Z'), 8);
  const desc = keyDescriptor(parseChord('A').main);
  assert.equal(desc.key, 'A');
  assert.equal(desc.text, 'A');
  assert.equal(desc.code, 'KeyA');
  assert.equal(desc.vk, 65);
});

test('Control+A 是 Control+Shift+A；已經寫出的 Shift 不重複', () => {
  assert.deepEqual(parseChord('Control+A'), { modifiers: ['Control', 'Shift'], main: 'A' });
  assert.equal(bits('Control+A'), 2 | 8);
  assert.deepEqual(parseChord('Shift+A'), { modifiers: ['Shift'], main: 'A' });
  assert.deepEqual(parseChord('ShiftLeft+Z'), { modifiers: ['ShiftLeft'], main: 'Z' });
  assert.deepEqual(parseChord('Control+Shift+A'), { modifiers: ['Control', 'Shift'], main: 'A' });
  assert.equal(bits('ShiftLeft+Z'), 8);
});

test('小寫與非字母主鍵不隱含 Shift', () => {
  assert.deepEqual(parseChord('a'), { modifiers: [], main: 'a' });
  assert.deepEqual(parseChord('Shift+a'), { modifiers: ['Shift'], main: 'a' });
  assert.deepEqual(parseChord('Control+a'), { modifiers: ['Control'], main: 'a' });
  assert.deepEqual(parseChord('Shift+Tab'), { modifiers: ['Shift'], main: 'Tab' });
  assert.equal(bits('a'), 0);
  assert.equal(bits('Control+a'), 2);
});
