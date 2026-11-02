// tests/test_fmb_fuzz_keys.test.mjs
// 隨機化（fuzz）測試：daemon/keys.js 的鍵描述與和弦解析。
//
// 目的：以固定亂數種子產生大量隨機輸入，檢查「不崩潰」與解析不變量；
// 只使用 Node.js 標準函式庫，不連網、不讀寫檔案、不含任何憑證或個資。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, modifierBit, keyDescriptor, parseChord } from '../daemon/keys.js';

// 非 legacy 呼叫端（本檔名不符合 isLegacyTestCall）支援的修飾鍵。
// Ctrl／Command 是別名，parseChord 會原樣放進 modifiers（位元同 Control=2、Meta=4）。
const MODIFIER_NAMES = ['Alt', 'Control', 'ControlOrMeta', 'Ctrl', 'Meta', 'Command', 'Shift'];

// 產生和弦用的 token 池（刻意混入錯誤大小寫、合法別名與未定義鍵）。
const KEY_TOKENS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'F1', 'F6', 'F12', 'a', 'Q', '0', '7', '!', '~', '-', '中',
  'ab', 'AA', '1a', 'Ctrl', 'Command', 'ctrl', 'shift', 'Meta2',
];

// mulberry32：32 位元、決定性、零依賴的 PRNG（同一 seed 永遠同一序列）。
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: parseChord 對 2000 個隨機和弦永不崩潰，成功時必滿足不變量', () => {
  const rng = makeRng(0x5eed01);
  const junk = 'abcZ09+- _!@#中\t';
  let ok = 0;
  let rejected = 0;

  for (let i = 0; i < 2000; i++) {
    let chord;
    if (rng() < 0.15) {
      chord = '';
      const len = Math.floor(rng() * 10);
      for (let k = 0; k < len; k++) chord += junk[Math.floor(rng() * junk.length)];
    } else {
      const parts = [];
      const len = Math.floor(rng() * 4);
      for (let k = 0; k < len; k++) {
        const tok = KEY_TOKENS[Math.floor(rng() * KEY_TOKENS.length)];
        parts.push(rng() < 0.2 ? ` ${tok} ` : tok);
      }
      chord = parts.join('+');
      if (rng() < 0.1) chord += '+';
    }

    let parsed;
    try {
      parsed = parseChord(chord);
    } catch (e) {
      rejected += 1;
      assert.ok(e instanceof Error, `非 Error 例外：${String(e)}`);
      assert.match(
        e.message,
        /unknown modifier|unknown key|empty key chord/,
        `未預期的錯誤訊息：${e.message}（chord=${JSON.stringify(chord)}）`,
      );
      continue;
    }

    ok += 1;
    assert.equal(typeof parsed.main, 'string');
    assert.ok(parsed.main.length >= 1);
    assert.ok(Array.isArray(parsed.modifiers));
    for (const m of parsed.modifiers) {
      assert.ok(MODIFIER_NAMES.includes(m), `未定義的修飾鍵漏出：${JSON.stringify(m)}`);
    }
    const d = keyDescriptor(parsed.main);
    assert.ok(d && typeof d === 'object', `main 沒有 descriptor：${JSON.stringify(parsed.main)}`);
    assert.equal(typeof d.key, 'string');
    assert.equal(typeof d.vk, 'number');
    // 空白不影響語意：同一和弦加上多餘空白必須解析成相同結果。
    const rebuilt = [...parsed.modifiers, parsed.main].map((s) => `  ${s}  `).join(' + ');
    assert.deepEqual(parseChord(rebuilt), parsed);
  }

  assert.ok(ok > 0, '沒有任何成功樣本');
  assert.ok(rejected > 0, '沒有任何被拒絕樣本');
});

test('fuzz: keyDescriptor 對所有單字元（0x00–0x7F、隨機碼位）與隨機字串皆為總函式', () => {
  for (let code = 0; code < 0x80; code++) {
    const ch = String.fromCharCode(code);
    const d = keyDescriptor(ch);
    assert.ok(d && typeof d === 'object', `U+${code.toString(16)} 應有 descriptor`);
    assert.equal(d.key, ch);
    assert.equal(typeof d.vk, 'number');
    assert.ok(Number.isFinite(d.vk));
    assert.ok(d.code === null || typeof d.code === 'string');
    assert.ok(d.text === undefined || (typeof d.text === 'string' && d.text.length === 1));
  }

  const rng = makeRng(0xf00d);
  for (let i = 0; i < 1500; i++) {
    const len = 1 + Math.floor(rng() * 3);
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCodePoint(Math.floor(rng() * 0x2000));
    const d = keyDescriptor(s);
    if (d === null) continue;
    // 既有 quirk：NAMED 是物件字面值，繼承 Object.prototype，理論上可能回傳函式；
    // 這裡只斷言不崩潰，不把該行為當成規格。
    if (typeof d === 'function') continue;
    assert.equal(typeof d, 'object', `descriptor 型別異常：${String(s)}`);
    assert.equal(typeof d.key, 'string');
    assert.equal(typeof d.vk, 'number');
  }
});

test('fuzz: isModifier / modifierBit 對隨機字串一致且非已知修飾鍵為 0', () => {
  assert.equal(modifierBit('Alt'), 1);
  assert.equal(modifierBit('Control'), 2);
  assert.equal(modifierBit('ControlOrMeta'), 2);
  assert.equal(modifierBit('Meta'), 4);
  assert.equal(modifierBit('Shift'), 8);

  const rng = makeRng(0xabcdef);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
  for (let i = 0; i < 800; i++) {
    const len = 1 + Math.floor(rng() * 6);
    let s = '';
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rng() * alphabet.length)];
    const bit = modifierBit(s);
    assert.equal(typeof bit, 'number');
    assert.ok(Number.isFinite(bit));
    assert.equal(typeof isModifier(s), 'boolean');
    if (MODIFIER_NAMES.includes(s)) {
      assert.ok(bit > 0, `已知修飾鍵位元應大於 0：${s}`);
    } else {
      // 產生長度上限 6，構造不出 Object.prototype 上的名稱，可安全斷言。
      assert.equal(bit, 0, `非修飾鍵卻有非零位元：${s}`);
      assert.equal(isModifier(s), false, `非修飾鍵卻被視為修飾鍵：${s}`);
    }
  }
});
