// tests/fmb_w9_s06_keys_controlormeta_platform.test.mjs
// 回歸測試（fan-out 子任務 s06，波次 w9）：daemon/keys.js 在 macOS 上必須把
// ControlOrMeta 對應到 Meta（Command），而不是一律當成 Control。
//
// 產品 bug：Playwright 定義 ControlOrMeta 在 macOS 上是 Meta，但 daemon/keys.js 的
// MODIFIERS 表與 NAMED 表一律把它釘成 Control。於是 press('ControlOrMeta+a') 在 Mac 上
// 送出的是 Ctrl+A（游標移到行首）而不是 Cmd+A（全選）；Ctrl+C／V 同理。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；以 Object.defineProperty 切換
// process.platform 模擬 darwin／linux，每個案例結束後還原平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

function withPlatform(value, fn) {
  const previous = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: previous, configurable: true });
  }
}

test('darwin：ControlOrMeta 是 Meta（位元 4、Meta 描述子），isModifier 仍為 true', () => {
  withPlatform('darwin', () => {
    assert.equal(isModifier('ControlOrMeta'), true, 'ControlOrMeta 在 darwin 上仍是修飾鍵');
    assert.equal(modifierBit('ControlOrMeta'), 4, 'darwin 上必須是 Meta 位元 4，而非 Control 位元 2');
    assert.deepEqual(
      keyDescriptor('ControlOrMeta'),
      { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
      'darwin 上描述子必須是 Meta',
    );

    const parsed = parseChord('ControlOrMeta+a');
    assert.deepEqual(parsed, { modifiers: ['ControlOrMeta'], main: 'a' });
    assert.equal(modifierBit(parsed.modifiers[0]), 4, 'parseChord 後的修飾位元在 darwin 上必須是 4');
    assert.deepEqual(keyDescriptor(parsed.modifiers[0]), keyDescriptor('Meta'));

    // 其他修飾鍵不受平台切換影響
    assert.equal(modifierBit('Control'), 2);
    assert.equal(modifierBit('Meta'), 4);
    assert.equal(modifierBit('Alt'), 1);
    assert.equal(modifierBit('Shift'), 8);
  });
});

test('linux：ControlOrMeta 仍是 Control（位元 2、Control 描述子），isModifier 仍為 true', () => {
  withPlatform('linux', () => {
    assert.equal(isModifier('ControlOrMeta'), true, 'ControlOrMeta 在 linux 上仍是修飾鍵');
    assert.equal(modifierBit('ControlOrMeta'), 2, 'linux 上必須是 Control 位元 2');
    assert.deepEqual(
      keyDescriptor('ControlOrMeta'),
      { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' },
      'linux 上描述子必須是 Control',
    );

    const parsed = parseChord('ControlOrMeta+a');
    assert.deepEqual(parsed, { modifiers: ['ControlOrMeta'], main: 'a' });
    assert.equal(modifierBit(parsed.modifiers[0]), 2, 'parseChord 後的修飾位元在 linux 上必須是 2');
    assert.deepEqual(keyDescriptor(parsed.modifiers[0]), keyDescriptor('Control'));

    // 其他修飾鍵不受平台切換影響
    assert.equal(modifierBit('Control'), 2);
    assert.equal(modifierBit('Meta'), 4);
    assert.equal(modifierBit('Alt'), 1);
    assert.equal(modifierBit('Shift'), 8);
  });
});

test('平台切換結束後會還原，不會污染其他測試', () => {
  const before = process.platform;
  withPlatform('darwin', () => {
    assert.equal(process.platform, 'darwin');
  });
  assert.equal(process.platform, before, 'withPlatform 結束後必須還原原平台');
  withPlatform('linux', () => {
    assert.equal(process.platform, 'linux');
  });
  assert.equal(process.platform, before, 'withPlatform 結束後必須還原原平台');
});
