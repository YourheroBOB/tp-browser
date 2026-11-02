// daemon/keys.js 風險最高的邊緣案例釘選：'+' 既是和弦分隔符又是合法主鍵，
// parseChord 靠 literalPlus 分支區分兩者；改動此處極易把加號主鍵搞丟或把
// 多餘分隔符變成靜默錯誤。本檔只釘已驗證正確的行為，不修改原始碼。
// 純函式測試：不連網、不讀寫檔案、不啟動瀏覽器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

test('加號主鍵：多打一個 + 才是按 + 本體', () => {
  assert.deepEqual(parseChord('++'), { modifiers: [], main: '+' });
  assert.deepEqual(parseChord('Shift++'), { modifiers: ['Shift'], main: '+' });
  assert.deepEqual(parseChord('Control++'), { modifiers: ['Control'], main: '+' });
  assert.deepEqual(parseChord('Control+Shift++'), { modifiers: ['Control', 'Shift'], main: '+' });
});

test('加號主鍵有完整描述子，可走 dispatch 路徑', () => {
  const desc = keyDescriptor(parseChord('Shift++').main);
  assert.equal(desc.key, '+');
  assert.equal(desc.vk, 43);
  assert.equal(desc.text, '+');
});

test('分隔符寬容：中間多打的空片段忽略，單一結尾 + 視為多餘分隔符', () => {
  assert.deepEqual(parseChord('Control++a'), { modifiers: ['Control'], main: 'a' });
  assert.deepEqual(parseChord('a+'), { modifiers: [], main: 'a' });
  assert.deepEqual(parseChord('Control+'), { modifiers: [], main: 'Control' });
});

test('歧義 chord 必須拒絕而非靜默選鍵：兩個非修飾鍵不能同處一 chord', () => {
  assert.throws(() => parseChord('a++'), /unknown modifier "a"/);
  assert.throws(() => parseChord('+'), /empty key chord/);
  assert.throws(() => parseChord('toString+a'), /unknown modifier/);
});
