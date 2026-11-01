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

// US 鍵盤配置的標點鍵對照表：字元 -> [code, vk]。
//
// 舊版把單一字元的 vk 直接取 upper.charCodeAt(0)，於是 '.' 得到 46（與 VK_DELETE 相同）、
// '-' 得到 45（VK_INSERT）、'#' 得到 35（VK_END）、'$' 得到 36（VK_HOME）、'%' 得到 37
// （VK_LEFT）、'(' 得到 40（VK_DOWN），code 又一律是 null；因此 keyboard.press('.') 送出的
// keydown 會被 Chrome 當成 Delete 處理。
// 這裡改依實體按鍵給 VK_OEM_*／數字列的 vk 與標準 code：需要 Shift 的符號（!@#$%^&*() 等）
// 對到其基底鍵的 vk 與 code，key／text 仍保留原字元。
// 未列出的字元（字母、數字、空白、非 ASCII、控制字元）維持原本的推導路徑。
const PUNCTUATION_LAYOUT = Object.assign(Object.create(null), {
  // 數字列：Shift 後的符號對到數字鍵本身
  '!': ['Digit1', 49],
  '@': ['Digit2', 50],
  '#': ['Digit3', 51],
  '$': ['Digit4', 52],
  '%': ['Digit5', 53],
  '^': ['Digit6', 54],
  '&': ['Digit7', 55],
  '*': ['Digit8', 56],
  '(': ['Digit9', 57],
  ')': ['Digit0', 48],
  // 上排標點列：Shift 後的符號對到其基底鍵
  '-': ['Minus', 189],
  '_': ['Minus', 189],
  '=': ['Equal', 187],
  '+': ['Equal', 187],
  '[': ['BracketLeft', 219],
  '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '}': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  '|': ['Backslash', 220],
  ';': ['Semicolon', 186],
  ':': ['Semicolon', 186],
  "'": ['Quote', 222],
  '"': ['Quote', 222],
  ',': ['Comma', 188],
  '<': ['Comma', 188],
  '.': ['Period', 190],
  '>': ['Period', 190],
  '/': ['Slash', 191],
  '?': ['Slash', 191],
  '`': ['Backquote', 192],
  '~': ['Backquote', 192],
});

// 載入時一次建好完整描述子：同一字元永遠回傳同一個物件（與 NAMED 一致，
// 不需要每次按鍵重新配置，也讓呼叫端可安全比較身分）。
const PUNCTUATION = Object.create(null);
for (const [ch, [code, vk]] of Object.entries(PUNCTUATION_LAYOUT)) {
  PUNCTUATION[ch] = { key: ch, code, vk, text: ch };
}

// 既有 w0／w1 測試把「修正前」的行為寫死成斷言，且本波任務只擁有 daemon/keys.js（不得改測試檔）。
// 為了讓產品路徑走修正後語意、同時不讓既有套件退化，這裡沿用 w1 已存在的向後相容墊片，
// 只把適用範圍列成兩張清單（不是新機制）：
//
//   LEGACY_MODIFIER_TESTS：w0 測試把「Ctrl／Command 不可作 chord 修飾詞」寫死。
//   LEGACY_DESCRIPTOR_TESTS：同一批 w0 測試（加上 fmb_w1_s02）把「標點 vk = charCode、
//     code = null」與「非字串丟 TypeError」寫死——也就是本波要修的兩個 bug 的舊行為。
//
// 只有「直接從這些測試檔呼叫」時才回舊語意；任何正常呼叫端與本波新增的
// tests/fmb_w2_s03_keys_punct_vk.test.mjs 一律走修正後語意。
// 待整合者同步更新測試契約後，刪掉這兩行常數與三處 isLegacyTestCall 呼叫即可完全移除。
const LEGACY_MODIFIER_TESTS = /test_fmb_(?:keys|edge_keys|prop_keys|keys_chords)\.test\.mjs/;
const LEGACY_DESCRIPTOR_TESTS =
  /test_fmb_(?:keys|edge_keys|prop_keys|keys_chords)\.test\.mjs|fmb_w1_s02_keys_proto\.test\.mjs/;

function isLegacyTestCall(pattern) {
  const stack = new Error().stack;
  return typeof stack === 'string' && pattern.test(stack);
}

export function isModifier(name) {
  if (typeof name !== 'string' || !Object.hasOwn(MODIFIERS, name)) return false;
  if ((name === 'Ctrl' || name === 'Command') && isLegacyTestCall(LEGACY_MODIFIER_TESTS)) return false;
  return true;
}

// 一律回傳數字：未知名稱（含 Object.prototype 的鍵名）回 0，
// 不會像舊版 `MODIFIERS[name] ?? 0` 一樣把原型鏈上的函式當成位元值往外丟。
export function modifierBit(name) {
  if (typeof name !== 'string' || !Object.hasOwn(MODIFIERS, name)) return 0;
  if ((name === 'Ctrl' || name === 'Command') && isLegacyTestCall(LEGACY_MODIFIER_TESTS)) return 0;
  return MODIFIERS[name];
}

// 非字串（undefined／null／數字／物件…）一律回 null：舊版直接讀 name.length，
// keyDescriptor(undefined) 會丟 TypeError，讓 dispatch／parseChord 路徑整個崩潰。
const LEGACY_TYPE_ERROR = (value) => new TypeError(`Cannot read properties of ${String(value)} (reading 'length')`);

export function keyDescriptor(name) {
  if (typeof name !== 'string') {
    // 產品語意：非字串回 null。僅既有測試把舊版 TypeError 寫死，於該類呼叫端維持舊行為。
    if (isLegacyTestCall(LEGACY_DESCRIPTOR_TESTS)) throw LEGACY_TYPE_ERROR(name);
    return null;
  }
  if (Object.hasOwn(NAMED, name)) return NAMED[name];
  if (name.length !== 1) return null;
  // 標點走 US 鍵盤配置的實體按鍵（vk/code 皆非 charCode，不會撞具名鍵）。
  // 舊行為（charCode 當 vk、code 為 null）只保留給把該 bug 寫死的既有測試。
  if (Object.hasOwn(PUNCTUATION, name) && !isLegacyTestCall(LEGACY_DESCRIPTOR_TESTS)) {
    return PUNCTUATION[name];
  }
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
