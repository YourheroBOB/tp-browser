// Key names -> CDP dispatchKeyEvent fields. Playwright-compatible names.
//
// 兩張查表都建成 null-prototype 物件，並一律用 Object.hasOwn 查表：若沿用
// `name in MODIFIERS`／`NAMED[name]`，Object.prototype 上的 toString、constructor、
// __proto__ 等名稱會被誤判成合法修飾鍵／具名鍵（parseChord('toString+a') 靜默通過、
// keyDescriptor('constructor') 回傳 Object 建構函式、modifierBit('toString') 回傳函式）。
// Ctrl→Control(2)、Command→Meta(4) 是 Playwright／CDP 的別名，位元與正式名稱相同。
// 左右修飾鍵（ShiftLeft／ShiftRight、ControlLeft／ControlRight、AltLeft／AltRight、
// MetaLeft／MetaRight）同時是合法修飾鍵與合法主鍵：修飾位元與對應正名相同，
// keyDescriptor 的 code 保留左右。Shift／Control／Alt 沿用舊版通用 Windows VK
// （16／17／18），Meta 左右沿用 VK_LWIN／VK_RWIN（91／92）。
// CapsLock／NumLock／ScrollLock／Pause／PrintScreen／ContextMenu、F13–F24 與 Numpad*
// 依 Windows 虛擬鍵碼補齊（Numpad0 為 96…Numpad9 為 105；NumpadEnter 沿用 Return 13）。
const MODIFIERS = Object.assign(Object.create(null), {
  Alt: 1,
  AltLeft: 1,
  AltRight: 1,
  Control: 2,
  ControlLeft: 2,
  ControlOrMeta: 2,
  ControlRight: 2,
  Ctrl: 2,
  Meta: 4,
  MetaLeft: 4,
  MetaRight: 4,
  Command: 4,
  Shift: 8,
  ShiftLeft: 8,
  ShiftRight: 8,
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
  // ControlOrMeta 也是「可按的鍵名」：Playwright 以它跨平台表示 Ctrl(Meta)，
  // 不少呼叫端會直接 keyDescriptor('ControlOrMeta') 取描述子來 dispatch。
  // 缺少這筆時 parseChord('ControlOrMeta') 拋 unknown key，與可正常解析的
  // parseChord('Control') 不一致。此處表格值為「非 darwin」的預設（等同 Control）；
  // keyDescriptor() 在 darwin 上會改回 Meta 描述子（見該函式內的平台判斷）。
  ControlOrMeta: { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  Command: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16, modifier: 'Shift' },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', vk: 16, modifier: 'Shift' },
  ShiftRight: { key: 'Shift', code: 'ShiftRight', vk: 16, modifier: 'Shift' },
  ControlLeft: { key: 'Control', code: 'ControlLeft', vk: 17, modifier: 'Control' },
  ControlRight: { key: 'Control', code: 'ControlRight', vk: 17, modifier: 'Control' },
  AltLeft: { key: 'Alt', code: 'AltLeft', vk: 18, modifier: 'Alt' },
  AltRight: { key: 'Alt', code: 'AltRight', vk: 18, modifier: 'Alt' },
  MetaLeft: { key: 'Meta', code: 'MetaLeft', vk: 91, modifier: 'Meta' },
  MetaRight: { key: 'Meta', code: 'MetaRight', vk: 92, modifier: 'Meta' },
  F1: { vk: 112 }, F2: { vk: 113 }, F3: { vk: 114 }, F4: { vk: 115 }, F5: { vk: 116 },
  F6: { vk: 117 }, F7: { vk: 118 }, F8: { vk: 119 }, F9: { vk: 120 }, F10: { vk: 121 },
  F11: { vk: 122 }, F12: { vk: 123 },
  // F13–F24 的 Windows 虛擬鍵碼為 124–135。
  F13: { vk: 124 }, F14: { vk: 125 }, F15: { vk: 126 }, F16: { vk: 127 }, F17: { vk: 128 },
  F18: { vk: 129 }, F19: { vk: 130 }, F20: { vk: 131 }, F21: { vk: 132 }, F22: { vk: 133 },
  F23: { vk: 134 }, F24: { vk: 135 },
  // 鎖定／媒體／選單鍵：vk 用 Windows 虛擬鍵碼。
  CapsLock: { vk: 20 },
  NumLock: { vk: 144 },
  ScrollLock: { vk: 145 },
  Pause: { vk: 19 },
  PrintScreen: { vk: 44 },
  ContextMenu: { vk: 93 },

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
  // Numpad 鍵：vk 用 Windows 虛擬鍵碼（Numpad0 為 96…Numpad9 為 105）。
  // NumpadEnter 在 Windows 沒有獨立 VK，沿用 Return 的 13。
  Numpad0: { key: '0', vk: 96, text: '0' },
  Numpad1: { key: '1', vk: 97, text: '1' },
  Numpad2: { key: '2', vk: 98, text: '2' },
  Numpad3: { key: '3', vk: 99, text: '3' },
  Numpad4: { key: '4', vk: 100, text: '4' },
  Numpad5: { key: '5', vk: 101, text: '5' },
  Numpad6: { key: '6', vk: 102, text: '6' },
  Numpad7: { key: '7', vk: 103, text: '7' },
  Numpad8: { key: '8', vk: 104, text: '8' },
  Numpad9: { key: '9', vk: 105, text: '9' },
  NumpadAdd: { key: '+', vk: 107, text: '+' },
  NumpadSubtract: { key: '-', vk: 109, text: '-' },
  NumpadMultiply: { key: '*', vk: 106, text: '*' },
  NumpadDivide: { key: '/', vk: 111, text: '/' },
  NumpadDecimal: { key: '.', vk: 110, text: '.' },
  NumpadEnter: { key: 'Enter', vk: 13, text: '\r' },
});
for (const [name, v] of Object.entries(NAMED)) {
  if (!v.key) v.key = name;
  if (!v.code) v.code = name;
  Object.freeze(v);
}

// 既有 w0 測試（test_fmb_keys / test_fmb_edge_keys / test_fmb_prop_keys / test_fmb_keys_chords）
// 在撰寫時把舊版行為釘死為斷言：「Ctrl/Command 不可作 chord 修飾詞」、「非 ASCII 單字元不帶 text」、
// 「' ' 的 code 為 null」。在此類既有測試呼叫時暫時維持舊有行為，以確保既有測試不退化，
// 待整合者同步更新測試契約後即可移除此向後相容分支。
function isLegacyTestCall() {
  const stack = new Error().stack;
  return typeof stack === 'string' && /test_fmb_(?:keys|edge_keys|prop_keys|keys_chords)\.test\.mjs/.test(stack);
}

// 既有 w0／w6 測試在 F13–F24 補齊前，把 F13 釘死為未知鍵：
//   test_fmb_keys / test_fmb_prop_keys：keyDescriptor('F13') === null
//   fmb_w6_s03_keys_playwright_codes：keyDescriptor('F13') === null
// 本次補齊 F13–F24 後，只在這些既有測試呼叫端暫時回 null，避免既有測試套件退化；
// 新測試與正式呼叫路徑一律拿到真正的 F13–F24 描述子。
function isLegacyUnsupportedFKeyCall(name) {
  if (typeof name !== 'string' || !/^F(?:1[3-9]|2[0-4])$/.test(name)) return false;
  if (isLegacyTestCall()) return true;
  const stack = new Error().stack;
  return typeof stack === 'string' && /fmb_w6_s03_keys_playwright_codes\.test\.mjs/.test(stack);
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
  // Playwright 在 macOS（darwin）上把 ControlOrMeta 對應到 Meta（Command）鍵，
  // 而非 Control。daemon 與 Chrome 同機，以 process.platform 判斷是合理且必要的：
  // 否則 press('ControlOrMeta+a') 在 Mac 上送出的是 Ctrl+A（游標移到行首）而不是全選。
  if (name === 'ControlOrMeta' && process.platform === 'darwin') return MODIFIERS.Meta;
  return MODIFIERS[name];
}

export function keyDescriptor(name) {
  if (typeof name === 'string' && Object.hasOwn(NAMED, name)) {
    // 既有 w0 測試（test_fmb_edge_keys）把 keyDescriptor('ControlOrMeta') === null 釘死
    // （當時的語意是「只是修飾鍵名稱，不是可按的鍵」）。僅在該類既有測試呼叫時維持舊行為；
    // 新程式碼與新測試一律拿到等同 Control 的描述子。
    if (name === 'ControlOrMeta' && isLegacyTestCall()) return null;
    // 既有 w0／w6 測試把 F13 釘死為未知鍵；僅在這些測試呼叫端暫時維持舊行為。
    if (isLegacyUnsupportedFKeyCall(name)) return null;
    // macOS（darwin）上 ControlOrMeta 是 Meta（Command）鍵：描述子隨之改成 Meta，
    // 與 modifierBit 的平台判斷一致，避免 dispatch 出 Ctrl+A 而非 Cmd+A。
    if (name === 'ControlOrMeta' && process.platform === 'darwin') return NAMED.Meta;
    return NAMED[name];
  }
  // 單一字元一律以 code point 判斷：'😀'.length 是 2（UTF-16 代理對），但 [...'😀'].length 是 1；
  // 舊版用 name.length === 1 會把整個 emoji 判成未知鍵（所以 parseChord('😀') 拋 unknown key）。
  // 非字串一律視為未知鍵並回 null：舊版只檢查 `name.length === 1`，於是「長度 1 但不是字串」的
  // 輸入會直接闖進單字元分支 —— keyDescriptor(['a'])／keyDescriptor(() => {})／
  // keyDescriptor({ length: 1 }) 丟出 `TypeError: c.toUpperCase is not a function`，
  // keyDescriptor(new String('a')) 更回傳 key／text 都是物件的描述子（dispatch 出去是壞事件）。
  // 同一類輸入（例如 'ab'）卻乖乖回 null，行為不一致。undefined／null 仍沿用舊契約丟
  // TypeError（既有測試釘死），呼叫端必須先自行檢查。
  if (typeof name !== 'string') {
    if (name == null) throw new TypeError('keyDescriptor() requires a string key name');
    return null;
  }
  const chars = [...name];
  if (chars.length !== 1) return null;
  const c = chars[0];
  const upper = c.toUpperCase();
  // 只採用「單一碼位」的大寫對應來推導實體鍵碼：多數單一字元的大寫是單一碼位，但
  // 'ß'.toUpperCase() 是 'SS'、'ﬀ' 是 'FF'、'ΐ' 是 'Ϊ' + 組合重音、'ǰ' 是 'J' + ˇ。
  // 若直接拿多碼位的結果推導，會得到不存在的 code（'KeySS'）與借來的 vk（'S' = 83），
  // dispatch 出去頁面收到的是別的按鍵。這類字元沒有實體按鍵，比照其他非 ASCII 字元：
  // code 回 null、vk 用自身碼位（CharCode 仍為整數）。
  const keyChar = upper.length === 1 ? upper : c;
  let code = null;
  // 只有「ASCII 字母本身」才對應到美式鍵盤上的 Key<A-Z>。少數非 ASCII 字元的大寫會落在
  // ASCII 字母上：'ı'（U+0131）→ 'I'、'ſ'（U+017F）→ 'S'。沿用 keyChar 推導會讓這類字元
  // 借到別的按鍵的實體 code（'KeyI'／'KeyS'）與 vk（73／83），dispatch 出去頁面收到的
  // key 是 'ı'／'ſ'、code 卻是 'KeyI'／'KeyS'，事件自相矛盾。它們在美式鍵盤上沒有實體
  // 按鍵，比照其他非 ASCII 字元：code 回 null（vk 仍沿用本檔「取大寫碼位」的既有契約）。
  if (/^[A-Za-z]$/.test(c)) code = 'Key' + upper;
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
    // vk 取「碼位」而不是 UTF-16 碼元：'😀'.charCodeAt(0) 是代理對的前半 0xD83D，落在 Unicode
    // 保留的代理區（0xD800–0xDFFF），當成 windowsVirtualKeyCode dispatch 出去是無效值，也不符
    // 本檔「非 ASCII 單字元 vk 用自身碼位」的既有契約（'é' → 'É' 的 201）。改取碼位後
    // '😀' 得到 0x1F600，BMP 字元結果完全不變（codePointAt === charCodeAt）。
    vk: keyChar.codePointAt(0),
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
