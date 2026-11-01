// tests/fmb_w4_s07_keys_uppercase.test.mjs
// 回歸測試（fan-out 子任務 s07）：daemon/keys.js 對「大寫對應會膨脹成多碼位」的單一字元
// 推導出不存在實體鍵碼的產品 bug。
//
// 產品 bug：
//   keyDescriptor() 以 `c.toUpperCase()` 推導實體鍵碼。多數單一字元的大寫是單一碼位，
//   但 Unicode 有少數例外：'ß'.toUpperCase() === 'SS'（德文 sharp s）、'ﬀ' → 'FF'
//   （連字）、'ΐ' → 'Ϊ' + 組合重音、'ǰ' → 'J' + ˇ。舊版因此回傳
//     keyDescriptor('ß') = { key: 'ß', code: 'KeySS', vk: 83, text: 'ß' }
//   'KeySS' 不是任何實體按鍵的 code，vk 83 是 'S' 的鍵碼，CDP dispatch 出去頁面
//   收到的是別的按鍵。這類字元沒有實體按鍵，應比照其他非 ASCII 字元：code null、
//   vk 用自身碼位。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；檔名刻意不符合 isLegacyTestCall 的正規式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

// 這些字元的 toUpperCase() 會膨脹成多個碼位（測試前提會逐字驗證）。
const EXPANDING = ['ß', 'ﬀ', 'ﬅ', 'ΐ', 'ǰ'];

test('大寫會膨脹的字元不得推導出不存在的實體鍵碼與借來的 vk', () => {
  for (const c of EXPANDING) {
    assert.ok(c.toUpperCase().length > 1, `${c} 的大寫必須膨脹為多碼位（測試前提）`);
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子，不能是 null`);
    assert.equal(d.key, c);
    assert.equal(d.code, null, `${JSON.stringify(c)} 沒有實體按鍵碼，實際得到 ${d.code}`);
    assert.equal(
      d.vk,
      c.charCodeAt(0),
      `${JSON.stringify(c)} 的 vk 必須是自己的碼位，不能是大寫展開後第一個字母的鍵碼`,
    );
    assert.equal(d.text, c, `${JSON.stringify(c)} 是可列印字元，必須帶 text`);
  }
});

test('回歸：ß／ﬀ／ΐ 不再長出 KeySS／KeyFF 這類假鍵碼', () => {
  assert.equal(keyDescriptor('ß').code, null);
  assert.notEqual(keyDescriptor('ß').code, 'KeySS');
  assert.notEqual(keyDescriptor('ß').vk, 'S'.charCodeAt(0));
  assert.equal(keyDescriptor('ﬀ').code, null);
  assert.notEqual(keyDescriptor('ﬀ').code, 'KeyFF');
  assert.equal(keyDescriptor('ΐ').code, null);
  assert.equal(keyDescriptor('ǰ').code, null);
  // 這些字元仍可當 chord 的主鍵（不能被誤判成未知鍵）
  assert.deepEqual(parseChord('Shift+ß'), { modifiers: ['Shift'], main: 'ß' });
  assert.deepEqual(keyDescriptor(parseChord('Shift+ß').main), keyDescriptor('ß'));
});

test('既有推導不變：單一碼位大寫的 ASCII 與非 ASCII 字元', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
  // 單一碼位大寫的非 ASCII 字母維持舊語意：無實體 code、vk 取大寫碼位
  assert.equal(keyDescriptor('é').code, null);
  assert.equal(keyDescriptor('é').vk, 'É'.charCodeAt(0));
  assert.equal(keyDescriptor('é').text, 'é');
  assert.equal(keyDescriptor('中').code, null);
  assert.equal(keyDescriptor('中').vk, '中'.charCodeAt(0));
});

test('不變量：單一字元的 code 只可能是 Key<A-Z>、Digit<0-9>、Space 或 null', () => {
  const samples = [...EXPANDING, 'a', 'Z', '0', '9', ' ', 'é', 'Ω', '中', '😀', '+', '\n', '\u0000'];
  for (const c of samples) {
    const d = keyDescriptor(c);
    assert.ok(d, `${JSON.stringify(c)} 必須有描述子`);
    if (d.code !== null) {
      assert.match(
        d.code,
        /^(?:Key[A-Z]|Digit[0-9]|Space)$/,
        `${JSON.stringify(c)} 的 code ${JSON.stringify(d.code)} 不是合法實體鍵碼`,
      );
    }
    assert.ok(Number.isInteger(d.vk), `${JSON.stringify(c)} 的 vk 必須是整數`);
  }
});
