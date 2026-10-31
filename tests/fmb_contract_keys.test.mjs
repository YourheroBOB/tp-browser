import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isModifier,
  keyDescriptor,
  modifierBit,
  parseChord,
} from '../daemon/keys.js';

test('key helpers expose the documented callable signatures', () => {
  assert.equal(typeof isModifier, 'function');
  assert.equal(typeof modifierBit, 'function');
  assert.equal(typeof keyDescriptor, 'function');
  assert.equal(typeof parseChord, 'function');

  assert.equal(isModifier.length, 1);
  assert.equal(modifierBit.length, 1);
  assert.equal(keyDescriptor.length, 1);
  assert.equal(parseChord.length, 1);
});

test('modifier names and bits retain their public mapping', () => {
  assert.equal(isModifier('Alt'), true);
  assert.equal(isModifier('Control'), true);
  assert.equal(isModifier('ControlOrMeta'), true);
  assert.equal(isModifier('Meta'), true);
  assert.equal(isModifier('Shift'), true);
  assert.equal(isModifier('Hyper'), false);

  assert.equal(modifierBit('Alt'), 1);
  assert.equal(modifierBit('Control'), 2);
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('Meta'), 4);
  assert.equal(modifierBit('Shift'), 8);
  assert.equal(modifierBit('Unknown'), 0);
});

test('key descriptors retain named, letter, and digit return structures', () => {
  assert.deepEqual(keyDescriptor('Enter'), {
    key: 'Enter',
    code: 'Enter',
    vk: 13,
    text: '\r',
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

  assert.equal(keyDescriptor('NotAKey'), null);
});

test('parseChord returns modifier order and preserves public error types', () => {
  assert.deepEqual(parseChord('ControlOrMeta+a'), {
    modifiers: ['ControlOrMeta'],
    main: 'a',
  });

  assert.deepEqual(parseChord('Shift+ControlOrMeta+Enter'), {
    modifiers: ['Shift', 'ControlOrMeta'],
    main: 'Enter',
  });

  assert.throws(
    () => parseChord(''),
    { name: 'Error', message: 'empty key chord' },
  );

  assert.throws(
    () => parseChord('Hyper+a'),
    {
      name: 'Error',
      message: 'unknown modifier "Hyper" in chord "Hyper+a"',
    },
  );

  assert.throws(
    () => parseChord('Control+Nope'),
    {
      name: 'Error',
      message: 'unknown key "Nope" in chord "Control+Nope"',
    },
  );
});
