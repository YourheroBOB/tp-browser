// tests/fmb_w12_s07_keys_descriptor_input_and_astral_vk.test.mjs
// 回歸測試（fan-out 子任務 s07，波次 w12）：daemon/keys.js 的 keyDescriptor() 在
// 「非字串但 length === 1」與「非 BMP 字元」兩條路徑上的產品 bug。
//
// B1 非字串輸入驗證：舊版只檢查 `name.length === 1`，於是任何「長度 1 但不是字串」的輸入
//    都被當成單一字元並繼續往下讀 c.toUpperCase()：
//      keyDescriptor(['a'])          → TypeError: c.toUpperCase is not a function
//      keyDescriptor(() => {})       → 同上（函式的 length 是參數個數 = 0/1）
//      keyDescriptor({ length: 1 })  → 同上
//      keyDescriptor(new String('a'))→ { key: <String 物件>, code: 'KeyA', vk: 65, text: <String 物件> }
//    同屬「非字串」的 'ab'（或 7、true、{}）卻乖乖回 null，行為不一致；把物件放進
//    dispatchKeyEvent 的 key／text 會送出壞掉的事件。修正後非字串一律回 null，
//    只有 undefined／null 仍沿用舊契約丟 TypeError（既有測試釘死）。
// B2 非 BMP 字元的 vk：舊版用 keyChar.charCodeAt(0)，對 '😀' 得到代理對前半 0xD83D，
//    落在 Unicode 保留的代理區（0xD800–0xDFFF），既不是「自身碼位」也不是可用的
//    windowsVirtualKeyCode。本檔對非 ASCII BMP 字元的既有契約是「vk 取自身碼位」
//    （'é' → 201），非 BMP 字元應一致（'😀' → 0x1F600）；BMP 字元結果不變。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；檔名刻意不符合 isLegacyTestCall()
// 與 isLegacyUnsupportedFKeyCall() 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

test('B1：length === 1 的非字串輸入一律回 null，不得丟 c.toUpperCase 的 TypeError', () => {
  const cases = [
    ['單元素陣列 a', ['a']],
    ['單元素陣列 Z', ['Z']],
    ['單元素陣列 7', ['7']],
    ['單元素陣列空白', [' ']],
    ['String 物件', new String('a')],
    ['類陣列物件', { length: 1 }],
    ['類陣列物件＋toString', { length: 1, toString: () => 'a' }],
    ['Uint8Array(1)', new Uint8Array(1)],
    ['Buffer', Buffer.from('a')],
    ['單參數函式', (x) => x],
  ];
  for (const [label, value] of cases) {
    let descriptor;
    assert.doesNotThrow(() => {
      descriptor = keyDescriptor(value);
    }, `${label}：不得丟錯`);
    assert.equal(descriptor, null, `${label}：必須回 null（與其他未知鍵一致）`);
  }
});

test('B1：其餘非字串（數字、布林、物件、函式、Symbol、BigInt）也一律回 null', () => {
  const values = [7, 0, true, false, {}, [], () => {}, () => {}, Symbol('fake-key'), 10n];
  for (const value of values) {
    assert.equal(keyDescriptor(value), null, `keyDescriptor(${String(value)}) 必須回 null`);
  }
});

test('B1：undefined／null 仍沿用舊契約丟 TypeError（呼叫端必須先自行檢查）', () => {
  assert.throws(() => keyDescriptor(undefined), TypeError);
  assert.throws(() => keyDescriptor(null), TypeError);
  assert.throws(() => keyDescriptor(), TypeError);
});

test('B2：非 BMP 字元的 vk 必須是自身碼位，不得是代理對的一半', () => {
  for (const c of ['😀', '🚀', '𝄞', '𝒜', '𐍈']) {
    assert.ok(c.codePointAt(0) > 0xffff, `${c} 必須是非 BMP 字元（測試前提）`);
    const d = keyDescriptor(c);
    assert.ok(d, `${c} 必須有描述子`);
    assert.equal(d.key, c);
    assert.equal(d.text, c, `${c} 是可列印字元，必須帶 text`);
    assert.equal(d.code, null, `${c} 沒有實體按鍵碼`);
    assert.equal(typeof d.vk, 'number');
    assert.ok(Number.isInteger(d.vk), `${c} 的 vk 必須是整數`);
    assert.equal(d.vk, c.codePointAt(0), `${c} 的 vk 必須是自身碼位`);
    assert.ok(
      d.vk < 0xd800 || d.vk > 0xdfff,
      `${c} 的 vk 不得落在代理區 0xD800–0xDFFF，實際 ${d.vk}`,
    );
  }
});

test("B2 回歸：keyDescriptor('😀') 的 vk 不再等於 charCodeAt(0)（代理對前半）", () => {
  assert.equal('😀'.charCodeAt(0), 0xd83d, '測試前提：charCodeAt(0) 是代理對前半');
  const d = keyDescriptor('😀');
  assert.equal(d.vk, 0x1f600);
  assert.notEqual(d.vk, '😀'.charCodeAt(0));

  // 仍可當 chord 主鍵，解析結果與描述子一致
  assert.deepEqual(parseChord('Shift+😀'), { modifiers: ['Shift'], main: '😀' });
  assert.deepEqual(keyDescriptor(parseChord('Shift+😀').main), d);
});

test('既有字串行為不變：ASCII／BMP 非 ASCII／具名鍵／未知鍵／非字串 chord', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
  assert.deepEqual(keyDescriptor(' '), { key: ' ', code: 'Space', vk: 32, text: ' ' });

  // BMP 字元維持既有契約：vk 取大寫碼位（BMP 下 codePointAt === charCodeAt，故不受本次改動影響）
  assert.equal(keyDescriptor('é').vk, 'É'.charCodeAt(0));
  assert.equal(keyDescriptor('é').vk, 'é'.toUpperCase().codePointAt(0));
  assert.equal(keyDescriptor('é').vk, 201);
  assert.equal(keyDescriptor('é').code, null);
  assert.equal(keyDescriptor('ı').code, null);
  assert.equal(keyDescriptor('ı').vk, 'I'.charCodeAt(0));
  assert.equal(keyDescriptor('ß').code, null);
  assert.equal(keyDescriptor('中').vk, '中'.charCodeAt(0));

  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.equal(keyDescriptor('F1').vk, 112);
  assert.equal(keyDescriptor('CapsLock').vk, 20);

  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('ab'), null);
  assert.equal(keyDescriptor('NotAKey'), null);
  assert.equal(keyDescriptor('toString'), null);

  assert.deepEqual(parseChord(7), { modifiers: [], main: '7' });
});
