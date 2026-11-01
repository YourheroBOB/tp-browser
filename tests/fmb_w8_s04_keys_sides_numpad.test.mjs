// tests/fmb_w8_s04_keys_sides_numpad.test.mjs
// 回歸測試（fan-out 子任務 s04）：daemon/keys.js 先前把左右修飾鍵名、CapsLock 類鎖定鍵、
// F13–F24、Numpad* 全部當成未知鍵；但檔頭宣稱 Playwright 相容。
//
// 本檔逐一斷言 key、code、vk、modifier 與 chord 解析結果。純函式測試：不連網、不讀寫檔案、
// 不使用任何憑證；檔名刻意不符合 isLegacyTestCall 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

const bits = (chord) => parseChord(chord).modifiers.reduce((b, m) => b | modifierBit(m), 0);

// [鍵名, 正規修飾名, vk, modifierBit]
const SIDE_MODIFIERS = [
  ['ShiftLeft', 'Shift', 16, 8],
  ['ShiftRight', 'Shift', 16, 8],
  ['ControlLeft', 'Control', 17, 2],
  ['ControlRight', 'Control', 17, 2],
  ['AltLeft', 'Alt', 18, 1],
  ['AltRight', 'Alt', 18, 1],
  ['MetaLeft', 'Meta', 91, 4],
  ['MetaRight', 'Meta', 92, 4],
];

const LOCK_KEYS = [
  ['CapsLock', 20],
  ['NumLock', 144],
  ['ScrollLock', 145],
  ['Pause', 19],
  ['PrintScreen', 44],
  ['ContextMenu', 93],
];

const NUMPAD_KEYS = [
  ['Numpad0', '0', 96, '0'],
  ['Numpad1', '1', 97, '1'],
  ['Numpad2', '2', 98, '2'],
  ['Numpad3', '3', 99, '3'],
  ['Numpad4', '4', 100, '4'],
  ['Numpad5', '5', 101, '5'],
  ['Numpad6', '6', 102, '6'],
  ['Numpad7', '7', 103, '7'],
  ['Numpad8', '8', 104, '8'],
  ['Numpad9', '9', 105, '9'],
  ['NumpadAdd', '+', 107, '+'],
  ['NumpadSubtract', '-', 109, '-'],
  ['NumpadMultiply', '*', 106, '*'],
  ['NumpadDivide', '/', 111, '/'],
  ['NumpadDecimal', '.', 110, '.'],
];

test('左右修飾鍵名：可當主鍵，也可當 chord 修飾詞，位元與 code 正確', () => {
  for (const [name, canonical, vk, bit] of SIDE_MODIFIERS) {
    assert.equal(isModifier(name), true, `${name} 必須是修飾鍵`);
    assert.equal(modifierBit(name), bit, `${name} 的位元必須為 ${bit}`);
    assert.equal(modifierBit(name), modifierBit(canonical), `${name} 的位元必須與 ${canonical} 相同`);

    assert.deepEqual(
      keyDescriptor(name),
      { key: canonical, code: name, vk, modifier: canonical },
      `${name} 的描述子不正確`,
    );

    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
    assert.deepEqual(parseChord(`${name}+KeyA`), { modifiers: [name], main: 'KeyA' });
    assert.equal(bits(`${name}+KeyA`), bit);
  }
});

test('題目點名的左右修飾 chord 現在都能解析', () => {
  assert.deepEqual(parseChord('ShiftLeft+KeyA'), { modifiers: ['ShiftLeft'], main: 'KeyA' });
  assert.deepEqual(parseChord('ControlRight+c'), { modifiers: ['ControlRight'], main: 'c' });
  assert.deepEqual(parseChord('AltLeft+Tab'), { modifiers: ['AltLeft'], main: 'Tab' });
  assert.deepEqual(parseChord('MetaRight+KeyV'), { modifiers: ['MetaRight'], main: 'KeyV' });

  assert.equal(bits('ShiftLeft+KeyA'), 8);
  assert.equal(bits('ControlRight+c'), 2);
  assert.equal(bits('AltLeft+Tab'), 1);
  assert.equal(bits('MetaRight+KeyV'), 4);

  assert.equal(keyDescriptor('ShiftRight').code, 'ShiftRight');
  assert.equal(keyDescriptor('ControlLeft').code, 'ControlLeft');
  assert.equal(keyDescriptor('AltRight').code, 'AltRight');
  assert.equal(keyDescriptor('MetaRight').code, 'MetaRight');

  assert.deepEqual(keyDescriptor(parseChord('ControlRight+c').main), {
    key: 'c', code: 'KeyC', vk: 67, text: 'c',
  });
  assert.deepEqual(keyDescriptor(parseChord('MetaRight+KeyV').main), {
    key: 'v', code: 'KeyV', vk: 86, text: 'v',
  });
});

test('CapsLock／NumLock／ScrollLock／Pause／PrintScreen／ContextMenu 補上', () => {
  for (const [name, vk] of LOCK_KEYS) {
    assert.deepEqual(keyDescriptor(name), { key: name, code: name, vk }, `${name} 的描述子不正確`);
    assert.equal(keyDescriptor(name).text, undefined);
    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
  }
});

test('F13–F24 補上，vk 為 124–135', () => {
  for (let i = 0; i < 12; i += 1) {
    const name = `F${13 + i}`;
    const vk = 124 + i;
    assert.deepEqual(keyDescriptor(name), { key: name, code: name, vk }, `${name} 的描述子不正確`);
    assert.equal(keyDescriptor(name).text, undefined);
    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
  }
});

test('Numpad0–Numpad9 與四則運算、小數點鍵補上，vk 用 Windows 虛擬鍵碼', () => {
  for (const [name, key, vk, text] of NUMPAD_KEYS) {
    assert.deepEqual(keyDescriptor(name), { key, code: name, vk, text }, `${name} 的描述子不正確`);
    assert.deepEqual(parseChord(name), { modifiers: [], main: name });
    assert.deepEqual(parseChord(`Control+${name}`), { modifiers: ['Control'], main: name });
  }
});

test('NumpadEnter 補上，vk 沿用 Return 的 13', () => {
  assert.deepEqual(keyDescriptor('NumpadEnter'), {
    key: 'Enter', code: 'NumpadEnter', vk: 13, text: '\r',
  });
  assert.deepEqual(parseChord('NumpadEnter'), { modifiers: [], main: 'NumpadEnter' });
  assert.deepEqual(parseChord('Shift+NumpadEnter'), { modifiers: ['Shift'], main: 'NumpadEnter' });
});

test('題目點名的 CapsLock／F13／Numpad5／NumpadEnter 不再拋 unknown key', () => {
  assert.deepEqual(parseChord('CapsLock'), { modifiers: [], main: 'CapsLock' });
  assert.deepEqual(parseChord('F13'), { modifiers: [], main: 'F13' });
  assert.deepEqual(parseChord('Numpad5'), { modifiers: [], main: 'Numpad5' });
  assert.deepEqual(parseChord('NumpadEnter'), { modifiers: [], main: 'NumpadEnter' });
});

test('查表維持 null-prototype + hasOwn：原型鍵名不會因新增鍵而混入', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(isModifier(name), false);
    assert.equal(modifierBit(name), 0);
    assert.equal(keyDescriptor(name), null);
  }
});
