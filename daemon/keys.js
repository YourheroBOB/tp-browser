// Key names -> CDP dispatchKeyEvent fields. Playwright-compatible names.
const MODIFIERS = { Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8 };

const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18, modifier: 'Alt' },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' },
  Ctrl: { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  Command: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16, modifier: 'Shift' },
  F1: { vk: 112 }, F2: { vk: 113 }, F3: { vk: 114 }, F4: { vk: 115 }, F5: { vk: 116 },
  F6: { vk: 117 }, F7: { vk: 118 }, F8: { vk: 119 }, F9: { vk: 120 }, F10: { vk: 121 },
  F11: { vk: 122 }, F12: { vk: 123 },
};
for (const [name, v] of Object.entries(NAMED)) {
  if (!v.key) v.key = name;
  if (!v.code) v.code = name;
}

export function isModifier(name) { return name in MODIFIERS; }
export function modifierBit(name) { return MODIFIERS[name] ?? 0; }

export function keyDescriptor(name) {
  if (NAMED[name]) return NAMED[name];
  if (name.length === 1) {
    const c = name;
    const upper = c.toUpperCase();
    let code = null;
    if (/[A-Z]/.test(upper)) code = 'Key' + upper;
    else if (/[0-9]/.test(c)) code = 'Digit' + c;
    return {
      key: c,
      code,
      vk: upper.charCodeAt(0),
      text: /[ -~]/.test(c) ? c : undefined,
    };
  }
  return null;
}

// Parse "ControlOrMeta+a" -> { modifiers: ['ControlOrMeta'], main: 'a' }
export function parseChord(chord) {
  const parts = String(chord).split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key chord');
  const main = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  for (const m of modifiers) if (!isModifier(m)) throw new Error(`unknown modifier "${m}" in chord "${chord}"`);
  if (!keyDescriptor(main)) throw new Error(`unknown key "${main}" in chord "${chord}"`);
  return { modifiers, main };
}
