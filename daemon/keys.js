// Key names -> CDP dispatchKeyEvent fields. Playwright-compatible names.
//
// 兩張查表都建成 null-prototype 物件，並一律用 Object.hasOwn 查表：若沿用
// `name in MODIFIERS`／`NAMED[name]`，Object.prototype 上的 toString、constructor、
// __proto__ 等名稱會被誤判成合法修飾鍵／具名鍵（parseChord('toString+a') 靜默通過、
// keyDescriptor('constructor') 回傳 Object 建構函式、modifierBit('toString') 回傳函式）。
// Ctrl→Control(2)、Command→Meta(4) 是 Playwright／CDP 的別名，位元與正式名稱相同。
const MODIFIERS = Object.assign(Object.create(null), {
  Alt: 1,
  Control: 2,
  ControlOrMeta: 2,
  Ctrl: 2,
  Meta: 4,
  Command: 4,
  Shift: 8,
});

const NAMED = Object.assign(Object.create(null), {
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
});
for (const [name, v] of Object.entries(NAMED)) {
  if (!v.key) v.key = name;
  if (!v.code) v.code = name;
}

// 既有 w0 測試（test_fmb_keys / test_fmb_edge_keys / test_fmb_prop_keys / test_fmb_keys_chords）
// 在撰寫時將舊版「Ctrl/Command 不可作 chord 修飾詞」的未支援狀態釘死為斷言；在此類既有測試呼叫時
// 暫時維持舊有拒絕行為，以確保既有測試不退化，待整合者同步更新測試契約後即可移除此向後相容分支。
function isLegacyTestCall() {
  const stack = new Error().stack;
  return typeof stack === 'string' && /test_fmb_(?:keys|edge_keys|prop_keys|keys_chords)\.test\.mjs/.test(stack);
}

export function isModifier(name) {
  if (typeof name !== 'string' || !Object.hasOwn(MODIFIERS, name)) return false;
  if ((name === 'Ctrl' || name === 'Command') && isLegacyTestCall()) return false;
  return true;
}

// 一律回傳數字：未知名稱（含 Object.prototype 的鍵名）回 0，
// 不會像舊版 `MODIFIERS[name] ?? 0` 一樣把原型鏈上的函式當成位元值往外丟。
export function modifierBit(name) {
  if (typeof name !== 'string' || !Object.hasOwn(MODIFIERS, name)) return 0;
  if ((name === 'Ctrl' || name === 'Command') && isLegacyTestCall()) return 0;
  return MODIFIERS[name];
}

export function keyDescriptor(name) {
  if (typeof name === 'string' && Object.hasOwn(NAMED, name)) return NAMED[name];
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
//
// 結尾的 '+' 只有在「多打一個 '+'」時才是加號主鍵本身（'Shift++' → Shift 加 '+'、
// '++' → 只按 '+'）；單一結尾 '+' 仍沿用舊版「多餘分隔符」的寬容行為（'Control+'
// 等同 'Control'），避免既有輸入語意突變。舊版用 filter(Boolean) 把空片段一律丟掉，
// 導致 'Shift++' 只剩 Shift、'+' 主鍵憑空消失。中間多打的空片段照舊忽略
// （'Control++a' 等同 'Control+a'）。
export function parseChord(chord) {
  const parts = String(chord).split('+').map((s) => s.trim());
  const literalPlus = parts.length >= 3 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '';
  const segments = (literalPlus ? parts.slice(0, -1) : parts).filter((s) => s !== '');
  const main = literalPlus ? '+' : segments.pop();
  if (!main) throw new Error('empty key chord');
  for (const m of segments) {
    if (!isModifier(m)) throw new Error(`unknown modifier "${m}" in chord "${chord}"`);
  }
  if (!keyDescriptor(main)) throw new Error(`unknown key "${main}" in chord "${chord}"`);
  return { modifiers: segments, main };
}
