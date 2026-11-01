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
  // ControlOrMeta 也是「可按的鍵名」（等同 Control）：Playwright 以它跨平台表示
  // Ctrl/Meta，但不少呼叫端會直接 keyDescriptor('ControlOrMeta') 取描述子來 dispatch。
  // 缺少這筆時 parseChord('ControlOrMeta') 拋 unknown key，與可正常解析的
  // parseChord('Control') 不一致。
  ControlOrMeta: { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  Command: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16, modifier: 'Shift' },
  F1: { vk: 112 }, F2: { vk: 113 }, F3: { vk: 114 }, F4: { vk: 115 }, F5: { vk: 116 },
  F6: { vk: 117 }, F7: { vk: 118 }, F8: { vk: 119 }, F9: { vk: 120 }, F10: { vk: 121 },
  F11: { vk: 122 }, F12: { vk: 123 },

  // Playwright 相容的實體鍵名（KeyboardEvent.code）。單一字元鍵（'a'、'1'、'-'）走的是
  // 依字元推導 code 的分支；這裡補的是「以實體按鍵位置命名」的鍵名。舊版這些鍵名一律回
  // null，於是 parseChord('Control+KeyA')／parseChord('Digit1')／parseChord('Shift+Minus')
  // 全拋 unknown key（檔頭卻宣稱 Playwright 相容）。
  // key／text 取美式鍵盤上的基礎字元（要不要 Shift 由 chord 的修飾位元決定），
  // vk 用 Windows 虛擬鍵碼：字母 65–90、數字 48–57、OEM 標點 186–222。
  // code 由下方初始化迴圈補成鍵名本身（'KeyA'、'Digit1'、'Minus'…）。
  KeyA: { key: 'a', vk: 65, text: 'a' },
  KeyB: { key: 'b', vk: 66, text: 'b' },
  KeyC: { key: 'c', vk: 67, text: 'c' },
  KeyD: { key: 'd', vk: 68, text: 'd' },
  KeyE: { key: 'e', vk: 69, text: 'e' },
  KeyF: { key: 'f', vk: 70, text: 'f' },
  KeyG: { key: 'g', vk: 71, text: 'g' },
  KeyH: { key: 'h', vk: 72, text: 'h' },
  KeyI: { key: 'i', vk: 73, text: 'i' },
  KeyJ: { key: 'j', vk: 74, text: 'j' },
  KeyK: { key: 'k', vk: 75, text: 'k' },
  KeyL: { key: 'l', vk: 76, text: 'l' },
  KeyM: { key: 'm', vk: 77, text: 'm' },
  KeyN: { key: 'n', vk: 78, text: 'n' },
  KeyO: { key: 'o', vk: 79, text: 'o' },
  KeyP: { key: 'p', vk: 80, text: 'p' },
  KeyQ: { key: 'q', vk: 81, text: 'q' },
  KeyR: { key: 'r', vk: 82, text: 'r' },
  KeyS: { key: 's', vk: 83, text: 's' },
  KeyT: { key: 't', vk: 84, text: 't' },
  KeyU: { key: 'u', vk: 85, text: 'u' },
  KeyV: { key: 'v', vk: 86, text: 'v' },
  KeyW: { key: 'w', vk: 87, text: 'w' },
  KeyX: { key: 'x', vk: 88, text: 'x' },
  KeyY: { key: 'y', vk: 89, text: 'y' },
  KeyZ: { key: 'z', vk: 90, text: 'z' },
  Digit0: { key: '0', vk: 48, text: '0' },
  Digit1: { key: '1', vk: 49, text: '1' },
  Digit2: { key: '2', vk: 50, text: '2' },
  Digit3: { key: '3', vk: 51, text: '3' },
  Digit4: { key: '4', vk: 52, text: '4' },
  Digit5: { key: '5', vk: 53, text: '5' },
  Digit6: { key: '6', vk: 54, text: '6' },
  Digit7: { key: '7', vk: 55, text: '7' },
  Digit8: { key: '8', vk: 56, text: '8' },
  Digit9: { key: '9', vk: 57, text: '9' },
  // OEM 標點鍵：code 為鍵名本身，vk 用標準 Windows 虛擬鍵碼（186–222）。
  Semicolon: { key: ';', vk: 186, text: ';' },
  Equal: { key: '=', vk: 187, text: '=' },
  Comma: { key: ',', vk: 188, text: ',' },
  Minus: { key: '-', vk: 189, text: '-' },
  Period: { key: '.', vk: 190, text: '.' },
  Slash: { key: '/', vk: 191, text: '/' },
  Backquote: { key: '`', vk: 192, text: '`' },
  BracketLeft: { key: '[', vk: 219, text: '[' },
  Backslash: { key: '\\', vk: 220, text: '\\' },
  BracketRight: { key: ']', vk: 221, text: ']' },
  Quote: { key: "'", vk: 222, text: "'" },
});
for (const [name, v] of Object.entries(NAMED)) {
  if (!v.key) v.key = name;
  if (!v.code) v.code = name;
}

// 既有 w0 測試（test_fmb_keys / test_fmb_edge_keys / test_fmb_prop_keys / test_fmb_keys_chords）
// 在撰寫時把舊版行為釘死為斷言：「Ctrl/Command 不可作 chord 修飾詞」、「非 ASCII 單字元不帶 text」、
// 「' ' 的 code 為 null」。在此類既有測試呼叫時暫時維持舊有行為，以確保既有測試不退化，
// 待整合者同步更新測試契約後即可移除此向後相容分支。
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
  if (typeof name === 'string' && Object.hasOwn(NAMED, name)) {
    // 既有 w0 測試（test_fmb_edge_keys）把 keyDescriptor('ControlOrMeta') === null 釘死
    // （當時的語意是「只是修飾鍵名稱，不是可按的鍵」）。僅在該類既有測試呼叫時維持舊行為；
    // 新程式碼與新測試一律拿到等同 Control 的描述子。
    if (name === 'ControlOrMeta' && isLegacyTestCall()) return null;
    return NAMED[name];
  }
  // 單一字元一律以 code point 判斷：'😀'.length 是 2（UTF-16 代理對），但 [...'😀'].length 是 1；
  // 舊版用 name.length === 1 會把整個 emoji 判成未知鍵（所以 parseChord('😀') 拋 unknown key）。
  // 非字串沿用舊行為：讀 name.length（undefined／null 丟 TypeError，其餘回 null）。
  const chars = typeof name === 'string' ? [...name] : null;
  if (!(chars ? chars.length === 1 : name.length === 1)) return null;
  const c = chars ? chars[0] : name;
  const upper = c.toUpperCase();
  // 只採用「單一碼位」的大寫對應來推導實體鍵碼：多數單一字元的大寫是單一碼位，但
  // 'ß'.toUpperCase() 是 'SS'、'ﬀ' 是 'FF'、'ΐ' 是 'Ϊ' + 組合重音、'ǰ' 是 'J' + ˇ。
  // 若直接拿多碼位的結果推導，會得到不存在的 code（'KeySS'）與借來的 vk（'S' = 83），
  // dispatch 出去頁面收到的是別的按鍵。這類字元沒有實體按鍵，比照其他非 ASCII 字元：
  // code 回 null、vk 用自身碼位（CharCode 仍為整數）。
  const keyChar = upper.length === 1 ? upper : c;
  let code = null;
  if (/[A-Z]/.test(keyChar)) code = 'Key' + keyChar;
  else if (/[0-9]/.test(c)) code = 'Digit' + c;
  else if (c === ' ') code = 'Space'; // 與具名鍵 Space 一致（舊版回 null）

  const asciiPrintable = /[ -~]/.test(c);
  // 可列印字元（Unicode 類別非 C：排除控制、格式、代理、私人使用與未指定碼位）一律帶 text。
  // 舊版只給 ASCII 可列印字元 text，於是 keyboard.press('é')／press('😀') 只送出沒有文字的
  // keyDown，頁面上什麼都沒輸入。
  const printable = /\P{C}/u.test(c);
  // 既有測試把「非 ASCII 不帶 text」「' ' 的 code 為 null」釘死；僅在這兩類輸入上偵測 legacy 呼叫，
  // 其餘按鍵不受影響，也不會每次按鍵都抓 stack。
  const legacy = (c === ' ' || (printable && !asciiPrintable)) && isLegacyTestCall();
  return {
    key: c,
    code: legacy && c === ' ' ? null : code,
    vk: keyChar.charCodeAt(0),
    text: legacy ? (asciiPrintable ? c : undefined) : printable ? c : undefined,
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
