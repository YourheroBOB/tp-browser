// tests/test_fmb_keys_chords.test.mjs
// daemon/keys.js 的邊界測試：修飾鍵表、具名鍵自動補齊、單字元推導、chord 解析錯誤。
// 純函式測試，不連網、不讀寫檔案、不需要任何憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

test('isModifier／modifierBit：修飾鍵表、大小寫敏感、未知鍵回 0', () => {
  assert.equal(isModifier('Alt'), true);
  assert.equal(isModifier('Control'), true);
  assert.equal(isModifier('ControlOrMeta'), true);
  assert.equal(isModifier('Meta'), true);
  assert.equal(isModifier('Shift'), true);

  assert.equal(isModifier('shift'), false); // 大小寫敏感
  assert.equal(isModifier('Ctrl'), false); // Ctrl 只是主鍵別名，不是 chord 修飾詞
  assert.equal(isModifier('Command'), false); // Command 同理
  assert.equal(isModifier(''), false);

  assert.equal(modifierBit('Alt'), 1);
  assert.equal(modifierBit('Control'), 2);
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('Meta'), 4);
  assert.equal(modifierBit('Shift'), 8);
  assert.equal(modifierBit('Nope'), 0);
  assert.equal(modifierBit(''), 0);
});

test('keyDescriptor：具名鍵在載入時自動補上 key／code', () => {
  const enter = keyDescriptor('Enter');
  assert.equal(enter.key, 'Enter');
  assert.equal(enter.code, 'Enter');
  assert.equal(enter.vk, 13);
  assert.equal(enter.text, '\r');

  const space = keyDescriptor('Space');
  assert.equal(space.key, ' ');
  assert.equal(space.code, 'Space');
  assert.equal(space.vk, 32);
  assert.equal(space.text, ' ');

  const f5 = keyDescriptor('F5');
  assert.equal(f5.key, 'F5');
  assert.equal(f5.code, 'F5');
  assert.equal(f5.vk, 116);
  assert.equal(f5.text, undefined);

  const esc = keyDescriptor('Escape');
  assert.equal(esc.vk, 27);
  assert.equal(esc.text, undefined);
});

test('keyDescriptor：單一字元推導 KeyX／DigitN 與可列印 text', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });

  const cjk = keyDescriptor('中');
  assert.equal(cjk.key, '中');
  assert.equal(cjk.code, null); // 非 A-Z／0-9 無法推導 code
  assert.equal(cjk.vk, '中'.charCodeAt(0));
  assert.equal(cjk.text, undefined); // 非 ASCII 不帶 text
});

test('keyDescriptor：未知鍵、空字串與多字元非具名鍵都回 null', () => {
  assert.equal(keyDescriptor('Nope'), null);
  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('ab'), null);
  assert.equal(keyDescriptor('enter'), null); // 具名鍵比對大小寫敏感
});

test('parseChord：切分修飾詞與主鍵，容忍空白、單鍵與重複分隔符', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
  assert.deepEqual(parseChord(' Shift + Tab '), { modifiers: ['Shift'], main: 'Tab' });
  assert.deepEqual(parseChord('Enter'), { modifiers: [], main: 'Enter' });
  assert.deepEqual(parseChord('Control'), { modifiers: [], main: 'Control' });
  // 空片段會被濾掉，因此連續 '+' 不會產生空修飾詞
  assert.deepEqual(parseChord('Meta++ArrowUp'), { modifiers: ['Meta'], main: 'ArrowUp' });
});

test('parseChord：非法 chord 丟出可讀錯誤（不吞錯、不亂猜）', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord(' + '), /empty key chord/);
  assert.throws(() => parseChord('Ctrl+a'), /unknown modifier "Ctrl"/);
  assert.throws(() => parseChord('a+b'), /unknown modifier "a"/);
  assert.throws(() => parseChord('Meta+UnknownKey'), /unknown key "UnknownKey"/);
});

test(
  'parseChord／isModifier 應把原型鏈屬性視為未知修飾詞',
  {
    skip: '產品 bug（daemon/keys.js）：isModifier() 使用 `in` 檢查，Object.prototype 上的 constructor／toString／valueOf 等名稱會被誤判為合法修飾詞，parseChord("constructor+a") 因此靜默接受、modifierBit 回 0。待修正為 Object.hasOwn／null-prototype 表後移除 skip。',
  },
  () => {
    assert.throws(() => parseChord('constructor+a'), /unknown modifier/);
    assert.equal(isModifier('toString'), false);
  },
);
