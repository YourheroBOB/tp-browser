// tests/fmb_w14_s07_keys_lone_surrogate_vk.test.mjs
// 回歸測試（fan-out 子任務 s07，波次 w14）：daemon/keys.js 對「未成對的代理碼位」
// （U+D800–U+DFFF）推導出無效的 windowsVirtualKeyCode。
//
// 產品 bug（與 w12_s07 修掉的「非 BMP 字元 vk 取代理對前半」是同一類錯誤的另一個入口）：
//   keyDescriptor() 以 keyChar.codePointAt(0) 當 windowsVirtualKeyCode。成對的代理對
//   （真正的非 BMP 字元）已由 w12 修好；但**單獨一個**代理碼位仍然會整顆穿過
//   `[...name].length === 1` 的檢查（未成對的代理自成一个碼位），於是：
//     keyDescriptor('\uD83D') = { key: '\uD83D', code: null, vk: 0xD83D, text: undefined }
//   0xD83D 落在 Unicode 保留的代理區，不是合法的虛擬鍵碼，dispatch 出去是無效事件。
//
// 觸發情境很日常：代理人在 JS 裡用字串索引／slice 切字時會切出半個 emoji：
//   '😀'.slice(0, 1) === '\uD83D'   // 半個代理對
//   '😀'[0]          === '\uD83D'
// 把這個字元丟給 keyboard.press() 就會送出代理區的 vk。
//
// 修正後：這類輸入仍保留描述子（既有 fmb_w11_s07 的 U+0080–U+2FFF 全範圍掃描要求
// U+D800–U+DFFF 也必須有描述子，故不可改回 null），但 vk 用 0（CDP 對
// windowsVirtualKeyCode 0 的語意是「沒有對應的虛擬鍵」），不再送出保留區數值。
//
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證；檔名刻意不符合 isLegacyTestCall()
// 與 isLegacyUnsupportedFKeyCall() 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

const LONE_SURROGATES = ['\uD800', '\uD83D', '\uDC00', '\uDFFF'];

test('未成對的代理碼位不得產生落在代理區的 windowsVirtualKeyCode', () => {
  for (const c of LONE_SURROGATES) {
    assert.equal(c.length, 1, '測試前提：單一 UTF-16 碼元');
    const cp = c.codePointAt(0);
    assert.ok(cp >= 0xd800 && cp <= 0xdfff, '測試前提：碼位落在代理區');

    const d = keyDescriptor(c);
    // 既有 fmb_w11_s07 的掃描把「單一碼元一定有描述子」釘死，這裡不能改成 null。
    assert.ok(d, `${JSON.stringify(c)} 仍必須有描述子`);
    assert.equal(d.key, c);
    assert.equal(d.code, null, '代理碼位沒有實體按鍵碼');
    assert.equal(d.text, undefined, '代理碼位不可列印，不得帶 text');
    assert.equal(typeof d.vk, 'number', 'vk 必須是數字');
    assert.ok(Number.isInteger(d.vk), 'vk 必須是整數');
    assert.ok(
      d.vk < 0xd800 || d.vk > 0xdfff,
      `vk 不得落在代理區 U+D800–U+DFFF，實際 ${d.vk}`,
    );
    assert.equal(d.vk, 0, '沒有合法碼位可用時 vk 為 0（CDP：無對應虛擬鍵）');
  }
});

test("實務觸發點：切半的 emoji（'😀'.slice(0, 1)／'😀'[0]）不再送出代理區 vk", () => {
  const emoji = '😀';
  const half = emoji.slice(0, 1);
  assert.equal(half.length, 1);
  assert.equal(half, emoji[0], '測試前提：slice 與索引切字都會留下半個代理對');
  assert.ok(half.codePointAt(0) >= 0xd800 && half.codePointAt(0) <= 0xdfff);

  for (const value of [half, emoji[0]]) {
    const d = keyDescriptor(value);
    assert.ok(d);
    assert.equal(d.vk, 0, `切半的 emoji 不得送出代理區 vk，實際 ${d.vk}`);
  }

  // 完整的 emoji 不受影響（w12 契約：vk 取自身碼位）
  assert.equal(keyDescriptor(emoji).vk, 0x1f600);
});

test('U+D800–U+DFFF 全範圍掃描：一律有描述子、code 為 null、vk 不在代理區', () => {
  for (let cp = 0xd800; cp <= 0xdfff; cp += 1) {
    const c = String.fromCodePoint(cp);
    const d = keyDescriptor(c);
    assert.ok(d, `U+${cp.toString(16)} 必須有描述子`);
    assert.equal(d.key, c);
    assert.equal(d.code, null, `U+${cp.toString(16)} 不得取得實體鍵碼`);
    assert.equal(d.text, undefined, `U+${cp.toString(16)} 不得帶 text`);
    assert.ok(
      d.vk < 0xd800 || d.vk > 0xdfff,
      `U+${cp.toString(16)} 的 vk 不得落在代理區，實際 ${d.vk}`,
    );
  }
});

test('未成對的代理碼位仍可當 chord 主鍵，解析結果與描述子一致（不新增拋錯）', () => {
  const half = '\uD83D';
  assert.deepEqual(parseChord(half), { modifiers: [], main: half });
  assert.deepEqual(parseChord(`Shift+${half}`), { modifiers: ['Shift'], main: half });
  assert.deepEqual(keyDescriptor(parseChord(`Shift+${half}`).main), keyDescriptor(half));
});

test('既有 vk 契約不變：ASCII／BMP 非 ASCII／具名鍵／成對的非 BMP 字元', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('Z'), { key: 'Z', code: 'KeyZ', vk: 90, text: 'Z' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
  assert.equal(keyDescriptor(' ').vk, 32);
  assert.equal(keyDescriptor('\u0000').vk, 0, '控制字元碼位本來就是 0，與本次修補無關');

  // BMP 非 ASCII：vk 沿用「取大寫碼位」的既有契約
  assert.equal(keyDescriptor('é').vk, 201);
  assert.equal(keyDescriptor('中').vk, '中'.codePointAt(0));
  assert.equal(keyDescriptor('ß').vk, 'ß'.codePointAt(0));
  assert.equal(keyDescriptor('ı').vk, 'I'.charCodeAt(0));

  // 成對的非 BMP 字元：vk 取自身碼位且絕不落在代理區
  for (const astral of ['😀', '🚀', '𝄞']) {
    const d = keyDescriptor(astral);
    assert.equal(d.vk, astral.codePointAt(0));
    assert.ok(d.vk > 0xffff);
  }

  // 具名鍵與未知鍵行為不變
  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.equal(keyDescriptor('CapsLock').vk, 20);
  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('ab'), null);
  assert.equal(keyDescriptor('toString'), null);
  assert.throws(() => keyDescriptor(undefined), TypeError);
  assert.throws(() => keyDescriptor(null), TypeError);
});
