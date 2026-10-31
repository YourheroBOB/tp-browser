import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isModifier,
  modifierBit,
  keyDescriptor,
  parseChord,
} from '../daemon/keys.js';

test('modifier lookup distinguishes supported modifiers from unknown names', () => {
  assert.equal(isModifier('Control'), true);
  assert.equal(isModifier('ControlOrMeta'), true);
  assert.equal(isModifier('Shift'), true);
  assert.equal(isModifier('Hyper'), false);

  assert.equal(modifierBit('Control'), 2);
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('Shift'), 8);
  assert.equal(modifierBit('Unknown'), 0);
});

test('keyDescriptor covers named, printable, numeric, Unicode, empty and unknown keys', () => {
  assert.deepEqual(keyDescriptor('Enter'), {
    key: 'Enter',
    code: 'Enter',
    vk: 13,
    text: '\r',
  });
  assert.deepEqual(keyDescriptor('F12'), {
    key: 'F12',
    code: 'F12',
    vk: 123,
  });
  assert.deepEqual(keyDescriptor('a'), {
    key: 'a',
    code: 'KeyA',
    vk: 65,
    text: 'a',
  });
  assert.deepEqual(keyDescriptor('7'), {
    key: '7',
    code: 'Digit7',
    vk: 55,
    text: '7',
  });
  assert.deepEqual(keyDescriptor('!'), {
    key: '!',
    code: null,
    vk: 33,
    text: '!',
  });

  const unicode = keyDescriptor('é');
  assert.equal(unicode.key, 'é');
  assert.equal(unicode.code, null);
  assert.equal(unicode.vk, 201);
  assert.equal(unicode.text, undefined);

  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('NotAKey'), null);
});

test('parseChord accepts supported modifiers and normalizes surrounding whitespace', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), {
    modifiers: ['ControlOrMeta'],
    main: 'a',
  });
  assert.deepEqual(parseChord(' Shift + Alt + Enter '), {
    modifiers: ['Shift', 'Alt'],
    main: 'Enter',
  });
  assert.deepEqual(parseChord('Control+7'), {
    modifiers: ['Control'],
    main: '7',
  });
});

test('parseChord rejects empty chords, unknown modifiers and unknown keys', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier/);
  assert.throws(() => parseChord('Control+NotAKey'), /unknown key/);
  assert.throws(() => parseChord('NotAKey'), /unknown key/);
});
