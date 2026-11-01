// tests/fmb_w1_s02_keys_proto.test.mjs
// 回歸測試（fan-out 子任務 s02）：daemon/keys.js 的查表只能看「自有屬性」，不得被
// Object.prototype 的鍵名污染；同時釘住 Ctrl→Control、Command→Meta 別名的修飾鍵位元，
// 以及「結尾 '+' 是加號主鍵」的 chord 解析結果。
// 純函式測試：不連網、不讀寫檔案、不需要任何憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

// Object.prototype 上一定會存在的名稱（外加 __proto__ 這個存取器）。
const PROTO_NAMES = [
  'toString',
  'constructor',
  '__proto__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'valueOf',
];

const chordBits = (chord) => parseChord(chord).modifiers.reduce((bits, m) => bits | modifierBit(m), 0);

test('原型鏈鍵名不得被當成合法修飾鍵（isModifier／modifierBit 一律拒絕）', () => {
  for (const name of PROTO_NAMES) {
    assert.equal(isModifier(name), false, `isModifier(${name}) 必須為 false`);
    const bit = modifierBit(name);
    assert.equal(typeof bit, 'number', `modifierBit(${name}) 必須是數字，不能回傳函式`);
    assert.equal(bit, 0, `modifierBit(${name}) 必須為 0`);
  }
});

test('原型鏈鍵名不得被當成合法 chord 修飾詞（parseChord 必須丟 unknown modifier）', () => {
  for (const name of PROTO_NAMES) {
    const chord = `${name}+a`;
    assert.throws(
      () => parseChord(chord),
      (e) => e instanceof Error && e.message === `unknown modifier "${name}" in chord "${chord}"`,
      `${chord} 必須被明確拒絕，而不是靜默接受`,
    );
  }
});

test('原型鏈鍵名不得被當成具名鍵（keyDescriptor 回 null，而不是 Object.prototype 的成員）', () => {
  for (const name of PROTO_NAMES) {
    const d = keyDescriptor(name);
    assert.equal(d, null, `keyDescriptor(${name}) 必須為 null`);
    assert.notEqual(typeof d, 'function', `keyDescriptor(${name}) 不可回傳函式`);
  }
});

test('原型鏈鍵名單獨使用時也不得成為主鍵', () => {
  for (const name of PROTO_NAMES) {
    assert.throws(() => parseChord(name), /unknown key/, `${name} 不可當主鍵`);
  }
});

test('modifierBit 對任何非字串／未知名稱都回數字 0', () => {
  for (const value of [undefined, null, 0, 7, true, {}, [], Symbol('fake'), () => {}]) {
    assert.equal(typeof modifierBit(value), 'number', 'modifierBit 必須回傳數字');
    assert.equal(modifierBit(value), 0, `modifierBit(${String(value)}) 必須為 0`);
    assert.equal(isModifier(value), false, `isModifier(${String(value)}) 必須為 false`);
  }
  for (const name of ['', 'Nope', 'ctrl', 'CTRL', 'command', 'Control ', 'Control+Shift']) {
    assert.equal(modifierBit(name), 0, `modifierBit(${JSON.stringify(name)}) 必須為 0`);
    assert.equal(isModifier(name), false, `isModifier(${JSON.stringify(name)}) 必須為 false`);
  }
});

test('Ctrl／Command 別名納入修飾鍵判斷與 modifierBit', () => {
  assert.equal(isModifier('Ctrl'), true);
  assert.equal(isModifier('Command'), true);
  assert.equal(modifierBit('Ctrl'), 2, 'Ctrl 是 Control 的別名，位元同為 2');
  assert.equal(modifierBit('Command'), 4, 'Command 是 Meta 的別名，位元同為 4');

  // 位元可與其他修飾鍵直接疊加（CDP modifier bitmask）
  assert.equal(modifierBit('Ctrl') | modifierBit('Shift'), 10);
  assert.equal(modifierBit('Command') | modifierBit('Alt'), 5);

  // 大小寫仍敏感，不做模糊比對
  assert.equal(isModifier('ctrl'), false);
  assert.equal(isModifier('command'), false);
  assert.equal(modifierBit('CTRL'), 0);
});

test("parseChord('Ctrl+a')／('Command+c') 可解析，修飾位元分別為 2／4", () => {
  assert.deepEqual(parseChord('Ctrl+a'), { modifiers: ['Ctrl'], main: 'a' });
  assert.deepEqual(parseChord('Command+c'), { modifiers: ['Command'], main: 'c' });

  assert.equal(chordBits('Ctrl+a'), 2);
  assert.equal(chordBits('Command+c'), 4);
  assert.equal(chordBits('Ctrl+Shift+a'), 10);
  assert.equal(chordBits('ControlOrMeta+a'), 2);

  // 別名修飾鍵對應到 CDP 的正規名稱，dispatch 時不會送錯鍵
  assert.deepEqual(keyDescriptor(parseChord('Ctrl+a').modifiers[0]), keyDescriptor('Control'));
  assert.deepEqual(keyDescriptor(parseChord('Command+c').modifiers[0]), keyDescriptor('Meta'));
});

test("結尾多打一個 '+' 時，那個 '+' 就是主鍵本身（Shift++ → Shift 加 '+'）", () => {
  assert.deepEqual(parseChord('Shift++'), { modifiers: ['Shift'], main: '+' });
  assert.equal(chordBits('Shift++'), 8);
  assert.deepEqual(keyDescriptor(parseChord('Shift++').main), { key: '+', code: null, vk: 43, text: '+' });

  assert.deepEqual(parseChord('Ctrl+Shift++'), { modifiers: ['Ctrl', 'Shift'], main: '+' });
  assert.deepEqual(parseChord('Command++'), { modifiers: ['Command'], main: '+' });
  assert.deepEqual(parseChord('++'), { modifiers: [], main: '+' });
});

test('中間多打的空片段與單一結尾分隔符仍舊寬容（既有行為不回歸）', () => {
  assert.deepEqual(parseChord('Control++a'), { modifiers: ['Control'], main: 'a' });
  assert.deepEqual(parseChord('Meta++ArrowUp'), { modifiers: ['Meta'], main: 'ArrowUp' });
  assert.deepEqual(parseChord('+a'), { modifiers: [], main: 'a' });
  // 單一結尾 '+' 是「多餘分隔符」，不是 '+' 主鍵（要按 '+' 請寫 '++'）
  assert.deepEqual(parseChord('Control+'), { modifiers: [], main: 'Control' });
  assert.deepEqual(parseChord('ControlOrMeta+Shift+'), { modifiers: ['ControlOrMeta'], main: 'Shift' });
});

test('既有合法 chord 與錯誤契約不變', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
  assert.deepEqual(parseChord(' Shift + Tab '), { modifiers: ['Shift'], main: 'Tab' });
  assert.deepEqual(parseChord('Control + Shift + Tab'), { modifiers: ['Control', 'Shift'], main: 'Tab' });
  assert.deepEqual(parseChord('Enter'), { modifiers: [], main: 'Enter' });
  assert.deepEqual(parseChord('a'), { modifiers: [], main: 'a' });
  assert.deepEqual(parseChord(7), { modifiers: [], main: '7' });

  assert.throws(() => parseChord(''), (e) => e instanceof Error && e.message === 'empty key chord');
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord('+'), /empty key chord/);
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Control+Nope'), /unknown key "Nope"/);
  assert.throws(() => parseChord('a+b'), /unknown modifier "a"/);
});
