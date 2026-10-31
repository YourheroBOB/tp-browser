// 針對 daemon/keys.js（鍵名 -> CDP dispatchKeyEvent 欄位對照）的純函式測試。
// 不接觸網路、不讀寫檔案。
import test from 'node:test';
import assert from 'node:assert/strict';

import { keyDescriptor, parseChord, isModifier, modifierBit } from '../daemon/keys.js';

test('isModifier() 只認 CDP modifier 名稱', () => {
  for (const name of ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']) {
    assert.equal(isModifier(name), true, `${name} 應被視為 modifier`);
  }
  for (const name of ['Ctrl', 'Cmd', 'Command', 'Enter', 'a', '', 'control', 'SHIFT']) {
    assert.equal(isModifier(name), false, `${name} 不應被視為 modifier`);
  }
});

test('modifierBit() 對照 CDP 位元遮罩，未知修飾鍵回 0', () => {
  assert.equal(modifierBit('Alt'), 1);
  assert.equal(modifierBit('Control'), 2);
  // ControlOrMeta 與 Control 同一位元（跨平台 command/ctrl）
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('Meta'), 4);
  assert.equal(modifierBit('Shift'), 8);
  // Ctrl / Command 只是 keyDescriptor 的別名，不是 modifier 名稱
  assert.equal(modifierBit('Ctrl'), 0);
  assert.equal(modifierBit('Command'), 0);
  assert.equal(modifierBit('NoSuchModifier'), 0);
});

test('具名鍵回傳完整 CDP 描述', () => {
  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.deepEqual(keyDescriptor('Tab'), { key: 'Tab', code: 'Tab', vk: 9 });
  assert.deepEqual(keyDescriptor('Escape'), { key: 'Escape', code: 'Escape', vk: 27 });
  assert.deepEqual(keyDescriptor('Space'), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  assert.deepEqual(keyDescriptor('Ctrl'), { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' });
  assert.deepEqual(keyDescriptor('Command'), { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' });
  // F1..F12 只有 vk，key/code 由初始化迴圈補成同名
  assert.deepEqual(keyDescriptor('F1'), { key: 'F1', code: 'F1', vk: 112 });
  assert.deepEqual(keyDescriptor('F12'), { key: 'F12', code: 'F12', vk: 123 });
  // 表格物件是共用的，取兩次應為同一實例（避免每次按鍵都重新配置）
  assert.equal(keyDescriptor('Enter'), keyDescriptor('Enter'));
});

test('單一字元鍵依字元類別推算 code / vk / text', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('A'), { key: 'A', code: 'KeyA', vk: 65, text: 'A' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });

  // 符號沒有對應的實體 code，但仍可送 key/vk/text
  const plus = keyDescriptor('+');
  assert.equal(plus.key, '+');
  assert.equal(plus.code, null);
  assert.equal(plus.vk, 43);
  assert.equal(plus.text, '+');

  // 非 ASCII 單字元：不帶 text（避免產生錯誤的輸入事件）
  const han = keyDescriptor('中');
  assert.equal(han.key, '中');
  assert.equal(han.code, null);
  assert.equal(han.vk, '中'.charCodeAt(0));
  assert.equal(han.text, undefined);
});

test('無法辨識的鍵名回傳 null（大小寫敏感）', () => {
  for (const name of ['', 'EnterKey', 'NotAKey', 'PAGEUP', 'alt', 'shift', 'F13']) {
    assert.equal(keyDescriptor(name), null, `${JSON.stringify(name)} 應回傳 null`);
  }
});

test('parseChord() 拆解修飾鍵與主鍵（主鍵永遠是最後一段）', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
  assert.deepEqual(parseChord('Shift+Tab'), { modifiers: ['Shift'], main: 'Tab' });
  assert.deepEqual(parseChord('Shift + Control + Enter'), { modifiers: ['Shift', 'Control'], main: 'Enter' });
  assert.deepEqual(parseChord('a'), { modifiers: [], main: 'a' });
  assert.deepEqual(parseChord(' Control+A '), { modifiers: ['Control'], main: 'A' });
  assert.deepEqual(parseChord('Control+Shift+Alt+Meta+x'), {
    modifiers: ['Control', 'Shift', 'Alt', 'Meta'],
    main: 'x',
  });
});

test('parseChord() 拒絕空字串與未知修飾鍵／未知主鍵', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Control+NotAKey'), /unknown key "NotAKey"/);
  // 主鍵放中間時，前面那段會被當成 modifier 而失敗（文件化目前的錯誤訊息）
  assert.throws(() => parseChord('a+b'), /unknown modifier "a"/);
});

test('parseChord() 對多餘的分隔符採寬容解析（既有行為）', () => {
  // 空片段會被 filter(Boolean) 丟掉，因此前後多打的 '+' 不會報錯
  assert.deepEqual(parseChord('+a'), { modifiers: [], main: 'a' });
  assert.deepEqual(parseChord('Control++a'), { modifiers: ['Control'], main: 'a' });
});
