// Table-driven + property tests for daemon/keys.js (key chord -> CDP dispatch fields).
// Pure module, no network, no new dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyDescriptor, parseChord, isModifier, modifierBit } from '../daemon/keys.js';

const MODIFIER_NAMES = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];
const NAMED_MAINS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];

// Independently written expectation table (regression guard for the CDP vk map).
const VK_TABLE = [
  ['Enter', 13], ['Tab', 9], ['Escape', 27], ['Backspace', 8], ['Delete', 46],
  ['Insert', 45], ['Home', 36], ['End', 35], ['PageUp', 33], ['PageDown', 34],
  ['ArrowUp', 38], ['ArrowDown', 40], ['ArrowLeft', 37], ['ArrowRight', 39],
  ['Space', 32], ['Alt', 18], ['Control', 17], ['Ctrl', 17], ['Meta', 91],
  ['Command', 91], ['Shift', 16], ['F1', 112], ['F12', 123],
];

for (const [name, vk] of VK_TABLE) {
  test(`keyDescriptor: ${name} -> vk ${vk}`, () => {
    const d = keyDescriptor(name);
    assert.ok(d, `${name} should be a known key`);
    assert.equal(d.vk, vk);
    assert.equal(typeof d.key, 'string');
    assert.ok(d.key.length >= 1, name);
    assert.equal(typeof d.code, 'string');
    assert.ok(d.code.length >= 1, name);
  });
}

// Names that keyDescriptor() must resolve. NOTE: 'ControlOrMeta' is a
// *modifier-only* chord token (daemon/keys.js MODIFIERS) and intentionally has
// no standalone descriptor — it can never be dispatched as a key by itself.
const DESCRIPTOR_NAMES = [
  ...NAMED_MAINS, 'Alt', 'Control', 'Ctrl', 'Meta', 'Command', 'Shift',
];

test('property: every descriptor key maps to an integer vk in 1..255 with non-empty key/code', () => {
  for (const name of DESCRIPTOR_NAMES) {
    const d = keyDescriptor(name);
    assert.ok(d, name);
    assert.equal(Number.isInteger(d.vk), true, name);
    assert.ok(d.vk >= 1 && d.vk <= 255, `${name} vk ${d.vk}`);
    assert.equal(typeof d.key, 'string', name);
    assert.ok(d.key.length > 0, name);
    assert.equal(typeof d.code, 'string', name);
    assert.ok(d.code.length > 0, name);
  }
});

test('controlOrMeta: modifier-only token — accepted by isModifier/modifierBit/parseChord, absent from keyDescriptor', () => {
  // Invariant guarded here: the set of modifier tokens is a superset of the set
  // of shift-like descriptor keys; the extra member must not be key-dispatchable.
  for (const name of MODIFIER_NAMES) {
    assert.equal(isModifier(name), true, name);
    assert.ok(modifierBit(name) > 0, name);
  }
  assert.equal(isModifier('ControlOrMeta'), true);
  assert.equal(modifierBit('ControlOrMeta'), modifierBit('Control'));
  assert.equal(keyDescriptor('ControlOrMeta'), null);
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
});

test('monotonic: F1..F12 virtual key codes increase by exactly 1 from 112', () => {
  const vks = [];
  for (let n = 1; n <= 12; n += 1) vks.push(keyDescriptor(`F${n}`).vk);
  assert.equal(vks[0], 112);
  for (let i = 1; i < vks.length; i += 1) assert.equal(vks[i] - vks[i - 1], 1);
});

test('aliases: Ctrl==Control and Command==Meta agree on key/code/vk', () => {
  const pick = (n) => {
    const { key, code, vk } = keyDescriptor(n);
    return { key, code, vk };
  };
  assert.deepEqual(pick('Ctrl'), pick('Control'));
  assert.deepEqual(pick('Command'), pick('Meta'));
});

test('modifierBit: table values, powers of two, disjoint except the Control alias', () => {
  assert.deepEqual(MODIFIER_NAMES.map(modifierBit), [1, 2, 2, 4, 8]);
  assert.equal(modifierBit('Nope'), 0);
  assert.equal(modifierBit(''), 0);

  const distinct = [...new Set(MODIFIER_NAMES.map(modifierBit))];
  assert.deepEqual(distinct.sort((a, b) => a - b), [1, 2, 4, 8]);
  for (const bit of distinct) assert.equal(bit & (bit - 1), 0, `${bit} not a power of two`);
  for (let i = 0; i < distinct.length; i += 1) {
    for (let j = i + 1; j < distinct.length; j += 1) {
      assert.equal(distinct[i] & distinct[j], 0, `${distinct[i]} overlaps ${distinct[j]}`);
    }
  }
  assert.equal(distinct.reduce((acc, b) => acc | b, 0), 15);
});

test('isModifier: exact, case-sensitive membership', () => {
  for (const name of MODIFIER_NAMES) assert.equal(isModifier(name), true, name);
  for (const name of ['', ' ', 'ctrl', 'ALT', 'shift', 'ControlOrMeta ', 'a', 'A', 'Enter', 'Meta+Shift', 'Control+Shift']) {
    assert.equal(isModifier(name), false, name);
  }
});

const CHORD_TABLE = [
  ['a', [], 'a'],
  ['A', [], 'A'],
  ['7', [], '7'],
  ['Enter', [], 'Enter'],
  ['Space', [], 'Space'],
  ['ControlOrMeta+a', ['ControlOrMeta'], 'a'],
  ['Control+Shift+t', ['Control', 'Shift'], 't'],
  ['Shift+Control+t', ['Shift', 'Control'], 't'], // modifier order is preserved, not sorted
  ['Meta+Alt+Delete', ['Meta', 'Alt'], 'Delete'],
  ['Alt+F4', ['Alt'], 'F4'],
  ['Control+ArrowLeft', ['Control'], 'ArrowLeft'],
  [' Control + Shift + a ', ['Control', 'Shift'], 'a'],
];

for (const [chord, modifiers, main] of CHORD_TABLE) {
  test(`parseChord: ${JSON.stringify(chord)}`, () => {
    assert.deepEqual(parseChord(chord), { modifiers, main });
  });
}

test('property: parse -> rebuild -> parse is a fixed point for every chord shape', () => {
  const mains = ['a', 'Z', '0', '9', 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Space', 'F7', '-', '.', '/', '@'];
  const combos = [
    [], ['Alt'], ['Control'], ['Meta'], ['Shift'], ['ControlOrMeta'],
    ['Control', 'Shift'], ['Alt', 'Meta', 'Shift'], ['ControlOrMeta', 'Shift'],
  ];
  for (const mods of combos) {
    for (const main of mains) {
      const chord = [...mods, main].join('+');
      const parsed = parseChord(chord);
      assert.deepEqual(parsed, { modifiers: mods, main });
      assert.ok(keyDescriptor(parsed.main), chord);
      for (const m of parsed.modifiers) assert.equal(isModifier(m), true, chord);
      assert.equal(chord.split('+').pop(), parsed.main, chord);
      const rebuilt = [...parsed.modifiers, parsed.main].join('+');
      assert.deepEqual(parseChord(rebuilt), parsed, `${chord} -> ${rebuilt}`);
    }
  }
});

test('property: surrounding whitespace around each segment does not change the parse', () => {
  for (const chord of ['a', 'Control+a', 'Control+Shift+Enter', 'Alt+F4', 'Meta+ArrowUp']) {
    const padded = chord.split('+').map((s) => `  ${s}\t`).join(' + ');
    assert.deepEqual(parseChord(padded), parseChord(chord), padded);
  }
});

test('parseChord: rejects empty, unknown modifier and unknown key chords', () => {
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord('+'), /empty key chord/);
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Control+Shift+NotAKey'), /unknown key "NotAKey"/);
  assert.throws(() => parseChord('Control+shift+a'), /unknown modifier "shift"/);
  assert.throws(() => parseChord('a+b'), /unknown modifier "a"/);
});

test('parseChord: does not mutate the shared key descriptor table', () => {
  const snapshot = () => JSON.stringify(['Enter', 'a', 'Space', 'ArrowUp', 'Alt'].map((n) => keyDescriptor(n)));
  const before = snapshot();
  parseChord('Alt+Shift+Enter');
  parseChord('ControlOrMeta+a');
  parseChord('Space');
  assert.equal(snapshot(), before);
});

test('property: every printable ASCII character maps to itself with code/vk/text rules', () => {
  for (let cp = 0x20; cp <= 0x7e; cp += 1) {
    const c = String.fromCharCode(cp);
    const d = keyDescriptor(c);
    assert.ok(d, `missing descriptor for ${JSON.stringify(c)}`);
    assert.equal(d.key, c);
    assert.equal(d.text, c);
    assert.equal(d.vk, c.toUpperCase().charCodeAt(0));
    if (/[A-Za-z]/.test(c)) assert.equal(d.code, `Key${c.toUpperCase()}`);
    else if (/[0-9]/.test(c)) assert.equal(d.code, `Digit${c}`);
    else assert.equal(d.code, null);
  }
});

test('keyDescriptor: letters keep original case in key, uppercase in code/vk', () => {
  for (const c of ['a', 'z', 'A', 'Z']) {
    const d = keyDescriptor(c);
    assert.equal(d.key, c);
    assert.equal(d.code, `Key${c.toUpperCase()}`);
    assert.equal(d.vk, c.toUpperCase().charCodeAt(0));
  }
});

test('keyDescriptor: non-ASCII single char has no code/text; unknown multi-char is null', () => {
  const zh = keyDescriptor('中');
  assert.ok(zh);
  assert.equal(zh.key, '中');
  assert.equal(zh.code, null);
  assert.equal(zh.text, undefined);
  assert.equal(zh.vk, '中'.toUpperCase().charCodeAt(0));

  for (const bad of ['Foo', 'enter', 'ctrl', 'Arrow', '', '回車', 'F13']) {
    assert.equal(keyDescriptor(bad), null, JSON.stringify(bad));
  }
});
