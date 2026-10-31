// tests/test_fmb_regress_keys.test.mjs
// 回歸測試：daemon/keys.js 的按鍵對照與 chord 解析。
//
// 對應的防禦性痕跡：
//   - 檔尾的 for 迴圈替 F1–F12 這類「只宣告 vk」的具名鍵補上 key/code
//     → 曾經 F 鍵送出時缺 key/code，CDP 端收到不完整事件（等同沒按）。
//   - keyDescriptor() 只在 `/[ -~]/` 成立時給 text
//     → 曾經對非 ASCII 字元也硬塞 text，導致輸入框被塞入錯誤字元。
//   - 單一字元才推導 code/vk，其他一律回 null
//     → 曾經對未知多字元鍵硬送事件。
//   - MODIFIERS 內建 ControlOrMeta 別名並固定對應位元
//     → 跨平台快速鍵在 Windows/Linux 上失效。
//   - parseChord() 對空 chord／未知修飾鍵／未知鍵明確拋錯
//     → 曾經靜默送出錯誤組合鍵。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

test('keys：F1–F12 必須補齊 key 與 code（否則 CDP 事件缺欄位）', () => {
  for (let n = 1; n <= 12; n += 1) {
    const d = keyDescriptor(`F${n}`);
    assert.ok(d, `F${n} 應有描述`);
    assert.equal(d.vk, 111 + n);
    assert.equal(d.key, `F${n}`);
    assert.equal(d.code, `F${n}`);
    assert.equal(d.text, undefined);
  }
});

test('keys：具名鍵的 key/code/vk/text 對照', () => {
  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.deepEqual(keyDescriptor('Tab'), { key: 'Tab', code: 'Tab', vk: 9 });
  assert.deepEqual(keyDescriptor('Space'), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  assert.deepEqual(keyDescriptor('ArrowLeft'), { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
});

test('keys：單一字母與數字會推導出 CDP 需要的 code 與 vk', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
});

test('keys：非 ASCII 單一字元不得送出 text（避免輸入被誤植）', () => {
  const d = keyDescriptor('中');
  assert.ok(d);
  assert.equal(d.key, '中');
  assert.equal(d.code, null);
  assert.equal(d.text, undefined, '非 ASCII 字元不可帶 text');
});

test('keys：多字元且非具名鍵回傳 null（避免誤送未知按鍵）', () => {
  assert.equal(keyDescriptor('NotAKey'), null);
  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('😀'), null);
});

test('keys：ControlOrMeta 為跨平台別名，對應到 Control 位元', () => {
  assert.equal(isModifier('ControlOrMeta'), true);
  assert.equal(isModifier('a'), false);
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('ControlOrMeta'), modifierBit('Control'));
  assert.equal(modifierBit('Alt'), 1);
  assert.equal(modifierBit('Meta'), 4);
  assert.equal(modifierBit('Shift'), 8);
  assert.equal(modifierBit('NoSuchModifier'), 0);
});

test('keys：parseChord 正確解析修飾鍵與主鍵', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
  assert.deepEqual(parseChord('Shift + ArrowLeft'), { modifiers: ['Shift'], main: 'ArrowLeft' });
  assert.deepEqual(parseChord('Enter'), { modifiers: [], main: 'Enter' });
});

test('keys：非法 chord 會明確拋錯，不得靜默送出錯誤按鍵', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord('+'), /empty key chord/);
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Control+NotAKey'), /unknown key "NotAKey"/);
});
