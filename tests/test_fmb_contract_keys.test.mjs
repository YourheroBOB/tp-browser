// tests/test_fmb_contract_keys.test.mjs
// daemon/keys.js 公開介面「契約測試」：只鎖匯出面、函式簽名（arity）、回傳結構與錯誤訊息格式。
// 不重複 tests/test_fmb_keys.test.mjs 的行為測試；零依賴、零網路、不讀寫 repo 外路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as keys from '../daemon/keys.js';

test('contract/keys：模組匯出面 exactly 四個符號', () => {
  assert.deepEqual(
    Object.keys(keys).sort(),
    ['isModifier', 'keyDescriptor', 'modifierBit', 'parseChord'],
  );
});

test('contract/keys：四個匯出皆為 arity 1 的同步函式', () => {
  for (const [name, fn] of Object.entries(keys)) {
    assert.equal(typeof fn, 'function', `${name} 應為函式`);
    assert.equal(fn.length, 1, `${name} 應只吃一個引數`);
  }
});

test('contract/keys：isModifier 回傳 boolean（修飾鍵集合五個、大小寫敏感）', () => {
  for (const m of ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']) {
    assert.equal(keys.isModifier(m), true, m);
  }
  assert.equal(keys.isModifier('a'), false);
  assert.equal(keys.isModifier('ctrl'), false);
  assert.equal(keys.isModifier(''), false);
});

test('contract/keys：modifierBit 位元值契約（Control 與 ControlOrMeta 同一位元）', () => {
  assert.equal(keys.modifierBit('Alt'), 1);
  assert.equal(keys.modifierBit('Control'), 2);
  assert.equal(keys.modifierBit('ControlOrMeta'), 2);
  assert.equal(keys.modifierBit('Meta'), 4);
  assert.equal(keys.modifierBit('Shift'), 8);
  assert.equal(keys.modifierBit('NotAModifier'), 0);
});

test('contract/keys：keyDescriptor 單一字元 → { key, code, vk, text } 結構契約', () => {
  const a = keys.keyDescriptor('a');
  assert.deepEqual(Object.keys(a).sort(), ['code', 'key', 'text', 'vk']);
  assert.equal(a.key, 'a');
  assert.equal(a.code, 'KeyA');
  assert.equal(a.vk, 65);
  assert.equal(a.text, 'a');

  const five = keys.keyDescriptor('5');
  assert.equal(five.code, 'Digit5');
  assert.equal(five.vk, 53);
  assert.equal(five.text, '5');
});

test('contract/keys：keyDescriptor 命名鍵契約（Enter / Space / F1）', () => {
  assert.deepEqual(keys.keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.deepEqual(keys.keyDescriptor('Space'), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  const f1 = keys.keyDescriptor('F1');
  assert.equal(f1.key, 'F1');
  assert.equal(f1.code, 'F1');
  assert.equal(f1.vk, 112);
  assert.equal(f1.text, undefined);
});

test('contract/keys：keyDescriptor 未知鍵回傳 null', () => {
  assert.equal(keys.keyDescriptor('NoSuchKey'), null);
});

test('contract/keys：parseChord → { modifiers, main }（允許 + 兩側空白、無修飾鍵）', () => {
  assert.deepEqual(keys.parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
  assert.deepEqual(keys.parseChord('a'), { modifiers: [], main: 'a' });
  assert.deepEqual(keys.parseChord('Control + Shift + Tab'), { modifiers: ['Control', 'Shift'], main: 'Tab' });
});

test('contract/keys：parseChord 錯誤契約（皆為 Error、訊息格式固定）', () => {
  assert.throws(() => keys.parseChord(''), (e) => e instanceof Error && e.message === 'empty key chord');
  assert.throws(
    () => keys.parseChord('Foo+a'),
    (e) => e instanceof Error && e.message === 'unknown modifier "Foo" in chord "Foo+a"',
  );
  assert.throws(
    () => keys.parseChord('Control+Nope'),
    (e) => e instanceof Error && e.message === 'unknown key "Nope" in chord "Control+Nope"',
  );
});
