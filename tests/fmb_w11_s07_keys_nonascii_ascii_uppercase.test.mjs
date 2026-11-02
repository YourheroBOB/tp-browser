// tests/fmb_w11_s07_keys_nonascii_ascii_uppercase.test.mjs
// 回歸測試（fan-out 子任務 s07，波次 w11）：daemon/keys.js 對「大寫落在 ASCII 字母上」的
// 非 ASCII 單一字元，推導出別的按鍵的實體鍵碼。
//
// 產品 bug：
//   keyDescriptor() 以 c.toUpperCase() 推導美式鍵盤的實體鍵碼。上一波（w4_s07）修掉了
//   「大寫膨脹成多碼位」的情況（'ß' → 'KeySS'），但漏掉「大寫是單一碼位、卻跨出 ASCII」
//   的情況：
//     keyDescriptor('ı') = { key: 'ı', code: 'KeyI', vk: 73, text: 'ı' }  // U+0131 → 'I'
//     keyDescriptor('ſ') = { key: 'ſ', code: 'KeyS', vk: 83, text: 'ſ' }  // U+017F → 'S'
//   'ı'／'ſ' 在美式鍵盤上沒有實體按鍵，卻借到 KeyI／KeyS 的 code 與 vk；dispatch 出去
//   頁面收到的 key 是 'ı'、code 卻是 'KeyI'、windowsVirtualKeyCode 是 73（'I'），
//   同一個事件裡三個欄位互相矛盾，也與 'é' → code null 的既有契約不一致。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；檔名刻意不符合 isLegacyTestCall()
// 與 isLegacyUnsupportedFKeyCall() 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

// 這些非 ASCII 字元的大寫會落在單一 ASCII 字母上（測試前提會逐字驗證）。
const CROSS_MAPPED = [
  ['ı', 'I'], // U+0131 LATIN SMALL LETTER DOTLESS I
  ['ſ', 'S'], // U+017F LATIN SMALL LETTER LONG S
];

test('非 ASCII 字元的大寫即使落在 ASCII 字母，也不得借用 Key<A-Z> 實體鍵碼', () => {
  for (const [c, asciiUpper] of CROSS_MAPPED) {
    assert.equal(c.toUpperCase(), asciiUpper, `${c} 的大寫必須是 ASCII ${asciiUpper}（測試前提）`);
    assert.equal(c.length, 1, '測試前提：這些字元都是單一 UTF-16 碼元');

    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子，不能是 null`);
    assert.equal(d.key, c);
    assert.equal(d.text, c, `${JSON.stringify(c)} 是可列印字元，必須帶 text`);
    assert.equal(
      d.code,
      null,
      `${JSON.stringify(c)} 在美式鍵盤上沒有實體按鍵，code 必須是 null，實際得到 ${JSON.stringify(d.code)}`,
    );
    assert.notEqual(d.code, `Key${asciiUpper}`, `不得借用 ${asciiUpper} 的實體鍵碼`);
    // vk 沿用本檔既有契約「單一字元取大寫碼位」（'é' → 'É' 的 201，w4_s07 已釘死）。
    // 本次只修正實體 code，不動 vk 契約。
    assert.equal(d.vk, c.toUpperCase().charCodeAt(0));
  }
});

test('回歸：ı／ſ 不再長出 KeyI／KeyS，且仍可當 chord 主鍵', () => {
  assert.equal(keyDescriptor('ı').code, null);
  assert.equal(keyDescriptor('ſ').code, null);
  assert.notEqual(keyDescriptor('ı').code, 'KeyI');
  assert.notEqual(keyDescriptor('ſ').code, 'KeyS');

  assert.deepEqual(parseChord('Shift+ı'), { modifiers: ['Shift'], main: 'ı' });
  assert.deepEqual(keyDescriptor(parseChord('Shift+ı').main), keyDescriptor('ı'));
  assert.deepEqual(parseChord('ſ'), { modifiers: [], main: 'ſ' });
});

test('性質：U+0080–U+2FFF 的非 ASCII 字元一律不得取得 Key<A-Z>／Digit<0-9>／Space 實體鍵碼', () => {
  for (let cp = 0x80; cp <= 0x2fff; cp += 1) {
    const c = String.fromCodePoint(cp);
    const d = keyDescriptor(c);
    assert.ok(d, `U+${cp.toString(16)} 必須有描述子`);
    assert.equal(
      d.code,
      null,
      `U+${cp.toString(16)}（${c}）不是美式鍵盤上的實體按鍵，code 必須是 null，實際 ${JSON.stringify(d.code)}`,
    );
  }
});

test('既有推導不變：ASCII 字母／數字、空白、非 ASCII、多碼位大寫與具名鍵', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('A'), { key: 'A', code: 'KeyA', vk: 65, text: 'A' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
  assert.equal(keyDescriptor(' ').code, 'Space');

  // 非 ASCII（大寫為單一非 ASCII 碼位）與多碼位大寫：code 一律 null
  assert.equal(keyDescriptor('é').code, null);
  assert.equal(keyDescriptor('é').vk, 'É'.charCodeAt(0));
  assert.equal(keyDescriptor('中').code, null);
  assert.equal(keyDescriptor('ß').code, null);
  assert.equal(keyDescriptor('😀').code, null);

  // 以鍵名書寫時仍拿得到實體 code（美式鍵盤的 KeyI 就是 'i'）
  assert.deepEqual(keyDescriptor('KeyI'), { key: 'i', code: 'KeyI', vk: 73, text: 'i' });
  assert.deepEqual(keyDescriptor('Semicolon'), { key: ';', code: 'Semicolon', vk: 186, text: ';' });
});
