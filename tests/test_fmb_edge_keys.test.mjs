// tests/test_fmb_edge_keys.test.mjs
// 邊界與錯誤情境：daemon/keys.js 的鍵名對映與 chord 解析。
// 重點放在既有行為中容易出錯的邊界：空字串、控制字元、非 ASCII 單字元、
// 只有修飾鍵的 chord、結尾多餘的 '+'、以及非字串輸入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

test('修飾鍵位元：名稱大小寫敏感，未知名稱（含 Ctrl／Cmd）回 0', () => {
  assert.equal(modifierBit('Control'), 2);
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('Shift'), 8);
  assert.equal(modifierBit('Control') | modifierBit('Shift'), 10);
  assert.equal(modifierBit('Meta') | modifierBit('Shift'), 12);
  // 大小寫不同即視為未知名稱，避免默默送出錯誤的修飾鍵位元。
  assert.equal(modifierBit('control'), 0);
  assert.equal(modifierBit('NoSuchModifier'), 0);

  // Ctrl 只是「可按的鍵名」別名（keyDescriptor('Ctrl') 有效），並不在 MODIFIERS 內，
  // 因此不可當 chord 的修飾鍵前綴；這是既有實作行為，明確釘住以免誤用。
  assert.equal(isModifier('Ctrl'), false);
  assert.equal(modifierBit('Ctrl'), 0);
  assert.equal(isModifier('Cmd'), false);
  assert.equal(isModifier('Command'), false);
  assert.throws(() => parseChord('Ctrl+a'), /unknown modifier "Ctrl"/);
  assert.throws(() => parseChord('Cmd+a'), /unknown modifier "Cmd"/);
});

test('單一字元鍵：字母、數字、空白、控制字元與非 ASCII', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });

  const space = keyDescriptor(' ');
  assert.equal(space.key, ' ');
  assert.equal(space.code, null);
  assert.equal(space.vk, 32);
  assert.equal(space.text, ' ');

  // 不可列印字元不應帶 text，否則會把控制字元塞進輸入事件。
  const newline = keyDescriptor('\n');
  assert.equal(newline.text, undefined);
  assert.equal(newline.code, null);

  const cjk = keyDescriptor('中');
  assert.equal(cjk.code, null);
  assert.equal(cjk.vk, '中'.toUpperCase().charCodeAt(0));
  assert.equal(cjk.text, undefined);
});

test('具名鍵：Enter 帶 carriage return、F1 只有 vk、Ctrl 正規化成 Control', () => {
  const enter = keyDescriptor('Enter');
  assert.equal(enter.key, 'Enter');
  assert.equal(enter.code, 'Enter');
  assert.equal(enter.vk, 13);
  assert.equal(enter.text, '\r');

  const ctrl = keyDescriptor('Ctrl');
  assert.equal(ctrl.key, 'Control');
  assert.equal(ctrl.modifier, 'Control');

  const f1 = keyDescriptor('F1');
  assert.equal(f1.vk, 112);
  assert.equal(f1.key, 'F1'); // 建表時自動補上 key／code
  assert.equal(f1.code, 'F1');

  assert.equal(keyDescriptor('Space').text, ' ');
  assert.equal(keyDescriptor('ArrowLeft').vk, 37);
  assert.equal(keyDescriptor('PageDown').vk, 34);
});

test('不支援的鍵名回 null；非字串輸入會丟 TypeError（呼叫端必須先自行檢查）', () => {
  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('ControlOrMeta'), null); // 只是修飾鍵名稱，不是可按的鍵
  assert.equal(keyDescriptor('NotAKey'), null);
  assert.equal(keyDescriptor('123'), null); // 多字元數字不是單一按鍵

  // 目前實作直接讀 name.length，非字串會丟 TypeError。
  // 若未來改為回傳 null，請同步更新此測試與呼叫端。
  assert.throws(() => keyDescriptor(undefined), TypeError);
  assert.throws(() => keyDescriptor(null), TypeError);
});

test('parseChord：修飾鍵組合、空白容忍與單鍵', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
  assert.deepEqual(parseChord(' Shift + ArrowUp '), { modifiers: ['Shift'], main: 'ArrowUp' });
  assert.deepEqual(parseChord('Enter'), { modifiers: [], main: 'Enter' });
  assert.deepEqual(parseChord(7), { modifiers: [], main: '7' }); // 非字串先轉字串再解析
});

test('parseChord：結尾多餘的 "+" 會被忽略，最後一段仍作為主鍵（現行寬鬆行為）', () => {
  assert.deepEqual(parseChord('ControlOrMeta+Shift+'), { modifiers: ['ControlOrMeta'], main: 'Shift' });
});

test('parseChord：空字串、未知修飾鍵、未知主鍵與只有單一字母的 chord 都會丟錯', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('+'), /empty key chord/);
  assert.throws(() => parseChord('   +   '), /empty key chord/);
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Control+NotAKey'), /unknown key "NotAKey"/);
  // 單一字元不可當修飾鍵前綴，避免把 "a+b" 誤解為 modifier。
  assert.throws(() => parseChord('a+b'), /unknown modifier "a"/);
  // Command 是可按的鍵名，但目前不在 MODIFIERS 內，因此不能當修飾鍵。
  assert.throws(() => parseChord('Command+a'), /unknown modifier "Command"/);
});
