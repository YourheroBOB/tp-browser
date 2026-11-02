// tests/test_fmb_prop_keys.test.mjs
// 性質／表格驅動測試：daemon/keys.js 的鍵名與 chord 解析不變量。
//
// 只驗證「對任何輸入都必須成立」的性質，不重跑既有的鍵盤單元測試：
//   K1 形狀保持：具名鍵描述子永遠有非空 key/code 與 1..255 的整數 vk；
//               可列印 ASCII 單字元永遠保留 text，且只有 A-Z / 0-9 取得實體 code。
//   K2 身分／冪等：同一鍵名永遠回傳同一個描述子物件；chord 正規化後再解析結果相同。
//   K3 一致：修飾鍵描述子的 key 一定是合法修飾名，位元為 2 的冪且與名稱對應。
//   K4 邊界：非法 chord 一律拋 Error（不靜默回傳）；未知長度 != 1 的鍵名一律回 null。
//
// 重要事實（對照 daemon/keys.js 的 MODIFIERS 表）：合法的 chord 修飾鍵**只有五個**
//   Alt / Control / ControlOrMeta / Meta / Shift
// `Ctrl` 與 `Command` 只是 NAMED 的「鍵名」（keyDescriptor 可用），**不能**出現在 chord 裡，
// 否則 parseChord 會拋 `unknown modifier`。本檔以 CHORD_MODIFIERS 明確區分兩者。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

// daemon/keys.js 未匯出內部表，故以表格在測試端對齊公開契約。
const MODIFIER_BITS = { Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8 };
// 只有這五個可以當 chord 的修飾鍵（與 Playwright 的修飾鍵集合一致）。
const CHORD_MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];
// 這些是合法「鍵名」但**不是**合法「修飾鍵」。
const KEY_ONLY_ALIASES = ['Ctrl', 'Command'];

const NAMED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Alt', 'Control', 'Ctrl', 'Meta', 'Command', 'Shift',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];
const CHORD_KEYS = ['a', 'Z', '0', '9', '-', '=', '.', '/', 'Enter', 'Tab', 'Escape', 'Space', 'ArrowUp', 'PageDown', 'F1', 'F12'];

test('K1 表格：每個具名鍵的描述子形狀固定（key/code 非空、vk 為 1..255 整數）', () => {
  for (const name of NAMED_KEYS) {
    const d = keyDescriptor(name);
    assert.ok(d, `${name} 應有描述子`);
    assert.equal(typeof d.key, 'string');
    assert.ok(d.key.length >= 1, `${name}.key 不得為空字串`);
    assert.equal(typeof d.code, 'string');
    assert.ok(d.code.length >= 1, `${name}.code 不得為空字串`);
    assert.ok(Number.isInteger(d.vk), `${name}.vk 必須是整數`);
    assert.ok(d.vk >= 1 && d.vk <= 255, `${name}.vk 必須落在 1..255，實際 ${d.vk}`);
    if (d.text !== undefined) assert.equal(typeof d.text, 'string', `${name}.text 必須是字串`);
    // 身分／冪等：同一鍵名必須拿到同一個描述子物件
    assert.equal(keyDescriptor(name), d, `${name} 的描述子必須是穩定的同一物件`);
  }
});

test('K1 表格：可列印 ASCII 單字元的邊界（text 保留，僅字母/數字有實體 code）', () => {
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const c = String.fromCharCode(code);
    const d = keyDescriptor(c);
    assert.ok(d, `單一字元 ${JSON.stringify(c)} 必須有描述子`);
    assert.equal(d.key, c);
    assert.equal(d.text, c, '可列印 ASCII 必須保留 text');

    const upper = c.toUpperCase();
    if (/[A-Z]/.test(upper)) assert.equal(d.code, `Key${upper}`);
    else if (/[0-9]/.test(c)) assert.equal(d.code, `Digit${c}`);
    else assert.equal(d.code, null, `${JSON.stringify(c)} 沒有對應的實體按鍵碼`);

    assert.ok(Number.isInteger(d.vk), `${JSON.stringify(c)}.vk 必須是整數`);
    assert.ok(d.vk >= 0x20 && d.vk <= 0x7e, `${JSON.stringify(c)}.vk 必須落在可列印 ASCII 範圍`);
  }
});

test('K4 邊界：非 ASCII 或不可列印的單一字元不取得實體 code，也沒有 text', () => {
  for (const c of ['é', '中', '\t', '\u0000', '\u007f']) {
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 仍應有描述子`);
    assert.equal(d.key, c);
    assert.equal(d.code, null, `${JSON.stringify(c)} 不應有實體 code`);
    assert.equal(d.text, undefined, `${JSON.stringify(c)} 不應有 text`);
  }
});

test('K4 邊界：長度 != 1 且非具名鍵一律回傳 null（無描述子）', () => {
  for (const name of ['', 'ab', 'NotAKey', 'f1', 'enter', 'Control ', 'ControlA', 'F13']) {
    assert.equal(keyDescriptor(name), null, `${JSON.stringify(name)} 不應有描述子`);
  }
});

test('K3 表格：每個修飾名的位元都是正整數且為 2 的冪；大小寫敏感', () => {
  for (const [name, bit] of Object.entries(MODIFIER_BITS)) {
    assert.equal(isModifier(name), true, `${name} 應被視為修飾名`);
    assert.equal(modifierBit(name), bit, `${name} 的位元必須是 ${bit}`);
    assert.ok(Number.isInteger(bit) && bit > 0);
    assert.equal(bit & (bit - 1), 0, `${name} 的位元必須是 2 的冪`);
  }
  for (const name of ['Hyper', 'Double', '', 'ctrl', 'ALT', 'Alt ', 'ControlOrMeta+Shift', 'Control+Shift']) {
    assert.equal(isModifier(name), false, `${JSON.stringify(name)} 不應被視為修飾名`);
    assert.equal(modifierBit(name), 0, `${JSON.stringify(name)} 的位元必須是 0`);
  }
});

test('K3 邊界：Ctrl / Command 是合法鍵名但不是合法 chord 修飾鍵（避免誤用）', () => {
  for (const name of KEY_ONLY_ALIASES) {
    assert.ok(keyDescriptor(name), `${name} 必須仍是合法鍵名`);
    assert.equal(isModifier(name), false, `${name} 不可作為 chord 修飾鍵`);
    assert.equal(modifierBit(name), 0, `${name} 的修飾位元必須是 0`);
    assert.throws(
      () => parseChord(`${name}+a`),
      new RegExp(`unknown modifier "${name}"`),
      `${name}+a 必須被明確拒絕，而不是靜默接受`,
    );
  }
});

test('K3 不變量：修飾鍵描述子的 key 一定是合法修飾名，位元對應一致', () => {
  const table = [
    ['Alt', 'Alt'],
    ['Control', 'Control'],
    ['Ctrl', 'Control'],
    ['Meta', 'Meta'],
    ['Command', 'Meta'],
    ['Shift', 'Shift'],
  ];
  for (const [name, expectedKey] of table) {
    const d = keyDescriptor(name);
    assert.equal(d.key, expectedKey, `${name} 的 key 應為 ${expectedKey}`);
    assert.equal(isModifier(d.key), true, `${name} 的 key ${d.key} 必須是合法修飾名`);
    assert.ok(modifierBit(d.key) > 0, `${name} 的 key ${d.key} 必須有非零位元`);
    if (isModifier(name)) {
      assert.equal(modifierBit(d.key), modifierBit(name), `${name} 與 ${d.key} 的位元必須一致`);
    }
  }
});

test('K2 性質：parseChord 是 join("+") 的反運算（單一修飾鍵 × 多種主鍵）', () => {
  for (const mod of CHORD_MODIFIERS) {
    for (const main of CHORD_KEYS) {
      const chord = `${mod}+${main}`;
      const parsed = parseChord(chord);
      assert.deepEqual(parsed.modifiers, [mod], `${chord} 的修飾鍵必須原樣保留`);
      assert.equal(parsed.main, main);
      assert.equal(isModifier(mod), true);
      assert.ok(keyDescriptor(main), `主鍵 ${main} 必須有描述子`);
      // 往返：重組後再解析必須得到相同結果
      assert.deepEqual(parseChord([...parsed.modifiers, parsed.main].join('+')), parsed);
    }
  }
});

test('K2 性質：多修飾鍵的順序被保留，任意組合皆可往返且位元可疊加', () => {
  const combos = [
    ['Shift', 'Control'],
    ['Control', 'Shift'],
    ['Alt', 'Shift', 'Meta'],
    ['ControlOrMeta', 'Shift'],
    ['Alt', 'Control', 'Meta', 'Shift'],
  ];
  for (const mods of combos) {
    const parsed = parseChord(`${mods.join('+')}+a`);
    assert.deepEqual(parsed.modifiers, mods, '修飾鍵順序必須保留');
    assert.equal(parsed.main, 'a');
    assert.deepEqual(parseChord([...parsed.modifiers, parsed.main].join('+')), parsed);

    let bits = 0;
    for (const m of parsed.modifiers) {
      assert.equal(isModifier(m), true);
      bits |= modifierBit(m);
    }
    assert.ok(bits > 0, '合法 chord 的修飾位元必須非零');
  }
});

test('K2 性質：空白不影響解析結果（正規化後再解析是冪等）', () => {
  const chords = [
    'Control+a', ' Control+a ', 'Control + a', 'Control\t+\na',
    '  Shift +  ArrowUp  ', 'Meta+Shift+z', 'ControlOrMeta + Shift + ArrowDown', 'Alt+F12',
  ];
  for (const chord of chords) {
    const parsed = parseChord(chord);
    const canonical = [...parsed.modifiers, parsed.main].join('+');
    assert.deepEqual(parseChord(canonical), parsed, `${JSON.stringify(chord)} 正規化後必須等價`);
    assert.deepEqual(parseChord(chord), parsed, '同一輸入必須得到相同解析（無隱藏狀態）');
  }
});

test('K4 邊界：非法 chord 一律拋 Error（不靜默回傳），訊息帶出問題 token', () => {
  assert.throws(() => parseChord('Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Alt+Hyper+a'), /unknown modifier "Hyper"/);
  assert.throws(() => parseChord('Control+NotAChordKey'), /unknown key "NotAChordKey"/);
  assert.throws(() => parseChord(''), /empty key chord/);
  assert.throws(() => parseChord('   '), /empty key chord/);
  assert.throws(() => parseChord('+'), /empty key chord/);

  for (const bad of ['Hyper+a', 'Control+Nope', 'Ctrl+a', 'Command+a', '', '  ']) {
    assert.throws(() => parseChord(bad), Error, `${JSON.stringify(bad)} 必須拋錯`);
  }
});

test('K4 邊界（現行行為）：結尾多餘的 "+" 會被忽略，等同只有主鍵', () => {
  // 這是 parseChord 以 filter(Boolean) 過濾空片段的既有行為；記錄下來是為了
  // 未來調整（例如改成嚴格報錯）時能被偵測，不代表背書。
  const parsed = parseChord('Control+');
  assert.deepEqual(parsed.modifiers, []);
  assert.equal(parsed.main, 'Control');
  assert.deepEqual(parseChord('Control+'), parseChord('Control'));
});

test('K2+K3 性質：隨機組合的合法 chord 全部可解析且不變量成立', () => {
  let seed = 0x1234567;
  const nextInt = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };

  for (let i = 0; i < 200; i += 1) {
    const modCount = nextInt(4);
    const mods = [];
    for (let k = 0; k < modCount; k += 1) mods.push(CHORD_MODIFIERS[nextInt(CHORD_MODIFIERS.length)]);
    const main = CHORD_KEYS[nextInt(CHORD_KEYS.length)];
    const chord = [...mods, main].join('+');

    const parsed = parseChord(chord);
    assert.deepEqual(parsed.modifiers, mods, `${chord} 的修飾鍵必須原樣保留`);
    assert.equal(parsed.main, main);
    for (const m of parsed.modifiers) assert.equal(isModifier(m), true);
    assert.ok(keyDescriptor(parsed.main), `${chord} 的主鍵必須有描述子`);
    assert.deepEqual(parseChord([...parsed.modifiers, parsed.main].join('+')), parsed, `${chord} 必須可往返`);
  }
});

test('K3 回歸：isModifier／modifierBit 只認 MODIFIERS 自有鍵，原型鍵名不是修飾鍵', () => {
  // 期望行為：任何非表中自有的鍵名都應被視為非修飾鍵。
  assert.equal(isModifier('toString'), false);
  assert.equal(isModifier('constructor'), false);
  assert.equal(isModifier('hasOwnProperty'), false);
  assert.equal(modifierBit('toString'), 0);
  // daemon/keys.js 已改用 null-prototype 表＋Object.hasOwn，本測試防止回退。
});
