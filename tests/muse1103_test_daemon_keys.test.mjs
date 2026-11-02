// tests/muse1103_test_daemon_keys.test.mjs
// Focused edge/error-path tests for daemon/keys.js not covered elsewhere:
// F-key boundaries, physical-name strictness, single-char descriptor freshness,
// implicit Shift with multiple modifiers, modifier-as-main chords, and
// String-coercion error paths of parseChord.
// Pure-function tests: no network, no file I/O, no credentials, no browsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

const bits = (chord) => parseChord(chord).modifiers.reduce((b, m) => b | modifierBit(m), 0);

test('F-key boundaries: F0/F25/malformed F names are unknown, F12-F24 stay valid', () => {
  for (const name of ['F0', 'F25', 'F1x', 'FF12', 'F13x']) {
    assert.equal(keyDescriptor(name), null, `${name} must be unknown`);
  }
  assert.equal(keyDescriptor('F12').vk, 123);
  assert.equal(keyDescriptor('F13').vk, 124);
  assert.equal(keyDescriptor('F24').vk, 135);
  assert.throws(() => parseChord('Control+F25'), /unknown key "F25"/);
  assert.throws(() => parseChord('F0'), /unknown key "F0"/);
});

test('physical key names are case-sensitive; partial names are unknown', () => {
  for (const name of ['keyA', 'KEYA', 'Keya', 'digit1', 'DIGIT1', 'Key', 'Digit', 'Numpad', 'MinusX', 'XKeyA']) {
    assert.equal(keyDescriptor(name), null, `${name} must be unknown`);
  }
  // Sanity: canonical forms still resolve.
  assert.equal(keyDescriptor('KeyA').code, 'KeyA');
  assert.equal(keyDescriptor('Digit1').code, 'Digit1');
  assert.equal(keyDescriptor('Minus').code, 'Minus');
});

test('single-char descriptors are fresh objects: mutation does not leak', () => {
  const first = keyDescriptor('a');
  assert.deepEqual(first, { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  const second = keyDescriptor('a');
  assert.notEqual(first, second, 'each call must return a new object');
  first.vk = 999;
  first.text = 'MUTATED';
  assert.deepEqual(
    keyDescriptor('a'),
    { key: 'a', code: 'KeyA', vk: 65, text: 'a' },
    'mutating a returned descriptor must not affect later lookups',
  );
  // Named descriptors stay shared/frozen (contrast case).
  assert.equal(keyDescriptor('F24'), keyDescriptor('F24'));
  assert.equal(Object.isFrozen(keyDescriptor('F24')), true);
});

test('uppercase main implies Shift with any modifier combination', () => {
  assert.deepEqual(parseChord('ControlOrMeta+A'), { modifiers: ['ControlOrMeta', 'Shift'], main: 'A' });
  assert.deepEqual(parseChord('Control+Alt+A'), { modifiers: ['Control', 'Alt', 'Shift'], main: 'A' });
  assert.equal(bits('Control+Alt+A'), 2 | 1 | 8);
  // Already-shifted variants gain no duplicate.
  assert.deepEqual(parseChord('ControlOrMeta+Shift+A'), { modifiers: ['ControlOrMeta', 'Shift'], main: 'A' });
  assert.deepEqual(parseChord('ShiftRight+A'), { modifiers: ['ShiftRight'], main: 'A' });
  // Lowercase and non-letters gain nothing.
  assert.deepEqual(parseChord('Control+Alt+a'), { modifiers: ['Control', 'Alt'], main: 'a' });
  assert.deepEqual(parseChord('Control+Alt+1'), { modifiers: ['Control', 'Alt'], main: '1' });
});

test('a modifier name is a legal chord main key', () => {
  assert.deepEqual(parseChord('Shift+Control'), { modifiers: ['Shift'], main: 'Control' });
  assert.deepEqual(parseChord('Control+Shift'), { modifiers: ['Control'], main: 'Shift' });
  assert.deepEqual(parseChord('Shift'), { modifiers: [], main: 'Shift' });
  assert.equal(isModifier(parseChord('Shift+Control').main), true);
});

test('parseChord coerces non-strings via String() before parsing', () => {
  assert.deepEqual(parseChord(0), { modifiers: [], main: '0' });
  assert.deepEqual(keyDescriptor(parseChord(0).main), keyDescriptor('0'));
  assert.throws(() => parseChord(null), /unknown key "null" in chord "null"/);
  assert.throws(() => parseChord(undefined), /unknown key "undefined" in chord "undefined"/);
  assert.throws(() => parseChord(false), /unknown key "false"/);
  // Trailing whitespace-only segment is dropped like a trailing separator.
  assert.deepEqual(parseChord('Control+ '), parseChord('Control'));
});
