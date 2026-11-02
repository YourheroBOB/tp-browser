// tests/fmb_w10_s07_keys_ascii_fold.test.mjs
// 回歸測試（fan-out 子任務 s07，波次 w10）：daemon/keys.js 對「非 ASCII 但大寫會折疊成
// 單一 ASCII 字母」的單一字元，推出不存在的實體鍵碼與借來的 vk。
//
// 產品 bug（與 w4_s07 的 'ß' 同一段推導邏輯，方向相反）：
//   keyDescriptor() 先取 toUpperCase() 得到 keyChar，再以 /[A-Z]/ 判斷是否推導 KeyX。
//   多數單一字元的大寫要嘛是同一個字元、要嘛膨脹成多碼位（'ß' → 'SS'，已於 w4_s07 修），
//   但另有一類會「折疊成單一 ASCII 字母」：
//     'ı'（U+0131 LATIN SMALL LETTER DOTLESS I）→ 'I'
//     'ſ'（U+017F LATIN SMALL LETTER LONG S）    → 'S'
//   舊版因此回傳 { key: 'ı', code: 'KeyI', vk: 73, text: 'ı' }：dispatch 出去頁面收到的是
//   I／S 實體鍵，而不是使用者要輸入的字元。這類字元沒有對應的實體按鍵，應比照其他
//   非 ASCII 字元：code 回 null。
//
//   附帶（同一個 vk 運算式）：astral 字元用 charCodeAt 只會拿到代理對的高位單元
//   （'😀' → 0xD83D），不是任何字元的碼位，與檔頭「vk 用自身碼位」的規則不符；
//   改用 codePointAt（BMP 字元結果完全相同）才正確。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；檔名刻意不符合 isLegacyTestCall 的正規式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

// [字元, 它的大寫]：實際會折疊成單一 ASCII 字母的字元（測試前提會逐字驗證）。
const ASCII_FOLDING = [
  ['ı', 'I'], // U+0131
  ['ſ', 'S'], // U+017F
];

test('前提：這些字元的大寫確實折疊成單一 ASCII 字母，且本身是單一碼位', () => {
  for (const [c, upper] of ASCII_FOLDING) {
    assert.equal([...c].length, 1, `${JSON.stringify(c)} 必須是單一碼位`);
    assert.equal(c.toUpperCase(), upper, `${JSON.stringify(c)} 的大寫應為 ${upper}`);
    assert.equal(upper.length, 1, '大寫必須是單一碼位（才不會被既有的「膨脹成多碼位」防線擋下）');
  }
});

test('非 ASCII 單一字元不得推出 ASCII 實體鍵碼（KeyI／KeyS）與借來的 vk', () => {
  for (const [c, upper] of ASCII_FOLDING) {
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子，不能是 null`);
    assert.equal(d.key, c);
    assert.equal(d.code, null, `${JSON.stringify(c)} 沒有實體按鍵，實際得到 ${d.code}`);
    assert.notEqual(d.code, `Key${upper}`, `${JSON.stringify(c)} 不可借用 ${upper} 的實體鍵碼`);
    assert.equal(d.text, c, `${JSON.stringify(c)} 是可列印字元，必須帶 text`);
    assert.ok(Number.isInteger(d.vk), `${JSON.stringify(c)} 的 vk 必須是整數`);
  }

  // 對照：真正的 ASCII 字母仍必須取得實體鍵碼（不可為了修 bug 而一起拔掉）
  assert.deepEqual(keyDescriptor('i'), { key: 'i', code: 'KeyI', vk: 73, text: 'i' });
  assert.deepEqual(keyDescriptor('s'), { key: 's', code: 'KeyS', vk: 83, text: 's' });

  // 這些字元仍可當 chord 的主鍵（不能被誤判成未知鍵）
  assert.deepEqual(parseChord('Shift+ı'), { modifiers: ['Shift'], main: 'ı' });
  assert.deepEqual(parseChord('Shift+ſ'), { modifiers: ['Shift'], main: 'ſ' });
  assert.deepEqual(keyDescriptor(parseChord('Shift+ſ').main), keyDescriptor('ſ'));
});

test('不變量（列舉 U+00A0–U+07FF）：非 ASCII 單一字元一律 code === null', () => {
  let checked = 0;
  for (let cp = 0x00a0; cp <= 0x07ff; cp += 1) {
    const c = String.fromCodePoint(cp);
    const d = keyDescriptor(c);
    assert.ok(d, `U+${cp.toString(16)} 必須有描述子`);
    assert.equal(d.key, c, `U+${cp.toString(16)} 的 key 必須是字元本身`);
    assert.equal(d.code, null, `U+${cp.toString(16)}（${JSON.stringify(c)}）不應有實體鍵碼 ${d.code}`);
    assert.ok(Number.isInteger(d.vk), `U+${cp.toString(16)} 的 vk 必須是整數`);
    checked += 1;
  }
  // 這個範圍涵蓋 Latin-1 Supplement／Latin Extended-A/B（含 ı、ſ）／希臘／西里爾。
  assert.ok(checked >= 1800, `掃描範圍太小（只檢查了 ${checked} 個碼位）`);
});

test('不變量：code 非 null ⟺ 該字元本身是可列印 ASCII，且符合 KeyA-Z／Digit0-9／Space', () => {
  const samples = [];
  for (let cp = 0x20; cp <= 0x7e; cp += 1) samples.push(String.fromCharCode(cp));
  for (const c of ['é', 'ü', 'ñ', 'Ω', 'Ж', '中', 'あ', '😀', '𝕏', 'ß', 'ﬀ', 'ﬅ', 'ΐ', 'ǰ', 'ı', 'ſ', '\u212a', '\u212b', '\t', '\u0000', '\u007f']) {
    samples.push(c);
  }

  for (const c of samples) {
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子`);
    if (d.code !== null) {
      assert.match(
        d.code,
        /^(?:Key[A-Z]|Digit[0-9]|Space)$/,
        `${JSON.stringify(c)} 的 code ${JSON.stringify(d.code)} 不是合法實體鍵碼`,
      );
      assert.match(
        d.key,
        /^[ -~]$/,
        `${JSON.stringify(c)} 取得實體鍵碼時，主字元必須是可列印 ASCII（實際 ${JSON.stringify(d.key)}）`,
      );
    }
  }
});

test('astral 字元的 vk 是其碼位，不是代理對的高位單元', () => {
  for (const c of ['😀', '𝕏', '🧪']) {
    assert.equal([...c].length, 1, `${JSON.stringify(c)} 必須是單一碼位（代理對）`);
    assert.equal(c.toUpperCase(), c, `${JSON.stringify(c)} 的大寫必須是自己（測試前提）`);
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子`);
    assert.equal(d.code, null, `${JSON.stringify(c)} 沒有實體按鍵碼`);
    assert.equal(d.text, c, `${JSON.stringify(c)} 必須帶 text`);
    assert.equal(d.vk, c.codePointAt(0), `${JSON.stringify(c)} 的 vk 必須是碼位 ${c.codePointAt(0)}`);
    assert.ok(d.vk > 0xffff, `${JSON.stringify(c)} 的 vk 必須大於 0xFFFF（不是代理對）`);
    assert.notEqual(d.vk, c.charCodeAt(0), `${JSON.stringify(c)} 的 vk 不可退回代理對高位單元`);
    assert.deepEqual(parseChord(c), { modifiers: [], main: c });
  }

  // BMP 字元不受影響：vk 仍取（單一碼位大寫的）碼位
  assert.equal(keyDescriptor('é').vk, 'É'.charCodeAt(0));
  assert.equal(keyDescriptor('中').vk, '中'.charCodeAt(0));
  assert.equal(keyDescriptor('a').vk, 65);
  assert.equal(keyDescriptor('7').vk, 55);
  assert.equal(keyDescriptor(' ').vk, 32);
});
