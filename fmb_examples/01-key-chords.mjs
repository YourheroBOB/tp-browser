#!/usr/bin/env node
// 離線範例：驗證 tp-browser 的鍵盤 chord 與按鍵描述解析。
// 不需要 daemon、瀏覽器、網路或任何憑證。
import assert from 'node:assert/strict';
import {
  isModifier,
  keyDescriptor,
  modifierBit,
  parseChord,
} from '../daemon/keys.js';

const letter = keyDescriptor('a');
assert.deepEqual(letter, {
  key: 'a',
  code: 'KeyA',
  vk: 65,
  text: 'a',
});

const enter = keyDescriptor('Enter');
assert.equal(enter.key, 'Enter');
assert.equal(enter.code, 'Enter');
assert.equal(enter.vk, 13);

assert.equal(isModifier('ControlOrMeta'), true);
assert.equal(isModifier('Hyper'), false);
assert.equal(modifierBit('ControlOrMeta'), 2);
assert.equal(modifierBit('Shift'), 8);

const controlChord = parseChord('ControlOrMeta+a');
assert.deepEqual(controlChord, {
  modifiers: ['ControlOrMeta'],
  main: 'a',
});

const enterChord = parseChord('Shift+Enter');
assert.deepEqual(enterChord, {
  modifiers: ['Shift'],
  main: 'Enter',
});

assert.throws(
  () => parseChord('Hyper+a'),
  /unknown modifier/,
  '未知 modifier 必須被拒絕',
);

assert.throws(
  () => parseChord('Control+NoSuchKey'),
  /unknown key/,
  '未知按鍵必須被拒絕',
);

console.log(JSON.stringify({
  example: 'key-chords',
  status: 'PASS',
  parsedChords: [controlChord, enterChord],
  modifierBits: {
    ControlOrMeta: modifierBit('ControlOrMeta'),
    Shift: modifierBit('Shift'),
  },
}, null, 2));
