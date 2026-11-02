// tests/fmb_w13_s07_keys_lone_surrogate.test.mjs
// 回歸測試（fan-out 子任務 s07，波次 w13）：daemon/keys.js 的 keyDescriptor() 會把
// 「單一 UTF-16 代理碼元（lone surrogate）」當成合法可按的鍵，回傳 windowsVirtualKeyCode
// 落在 Unicode 保留代理區（0xD800–0xDFFF）的描述子。
//
// 產品 bug（修正前）：
//   keyDescriptor('\uD83D')          → { key: '\uD83D', code: null, vk: 0xD83D, text: undefined }
//   keyDescriptor('😀'.slice(0, 1))  → 同上（真實情境：外部字串被截斷成 1 個字元，
//                                       例如貼上的 emoji 只留下半個代理對）
//   parseChord('😀'.slice(0, 1))     → 靜默成功（{ modifiers: [], main: '\uD83D' }）
// 單一代理碼元不是合法字元，在美式鍵盤上沒有實體按鍵，也沒有可用的 windowsVirtualKeyCode；
// 正確行為是回 null，讓 parseChord 明確拋 unknown key，而不是 dispatch 出無效事件。
// 合法代理對（'😀'）在 [...str] 下是「單一碼位、長度 2」，不在修正範圍，行為必須完全不變。
//
// 純函式測試：不連網、不讀寫檔案、不 spawn 任何程序、不使用任何憑證；檔名刻意不符合
// isLegacyTestCall() 與 isLegacyUnsupportedFKeyCall() 的正規式，才會驗到新行為。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifier, keyDescriptor, modifierBit, parseChord } from '../daemon/keys.js';

// [單一代理碼元, 說明]
const LONE_SURROGATES = [
  ['\uD800', '高代理起點'],
  ['\uD83D', 'emoji 前半（😀 被截斷）'],
  ['\uDBFF', '高代理終點'],
  ['\uDC00', '低代理起點'],
  ['\uDE00', 'emoji 後半'],
  ['\uDFFF', '低代理終點'],
];

test('單一代理碼元與被截斷的 emoji 都不是合法按鍵：keyDescriptor 回 null、parseChord 明確拋錯', () => {
  for (const [c, label] of LONE_SURROGATES) {
    assert.equal(c.length, 1, `${label} 必須是單一 UTF-16 碼元（測試前提）`);
    const unit = c.charCodeAt(0);
    assert.ok(unit >= 0xd800 && unit <= 0xdfff, `${label} 必須落在代理區（測試前提）`);
    assert.equal(
      keyDescriptor(c),
      null,
      `${label}（U+${unit.toString(16).toUpperCase()}）沒有實體按鍵，必須回 null`,
    );
    assert.throws(
      () => parseChord(c),
      (e) => e instanceof Error && e.message === `unknown key "${c}" in chord "${c}"`,
      `parseChord(${JSON.stringify(c)}) 必須明確拋 unknown key，不得靜默解析成可按的鍵`,
    );
  }

  // 真實情境：合法的代理對被截斷成半個字元
  assert.equal('😀'.length, 2, '測試前提：😀 是代理對');
  for (const c of ['😀'.slice(0, 1), '😀'.slice(1), '🚀'.slice(1)]) {
    assert.equal(c.length, 1, '測試前提：截斷後只剩單一碼元');
    assert.equal(keyDescriptor(c), null, `截斷後的 ${JSON.stringify(c)} 必須回 null`);
    assert.throws(() => parseChord(c), /unknown key/);
  }
});

test('合法的代理對（非 BMP 字元）行為完全不變', () => {
  for (const c of ['😀', '🚀', '𝄞']) {
    assert.ok(c.codePointAt(0) > 0xffff, `${c} 必須是非 BMP 字元（測試前提）`);
    assert.equal([...c].length, 1, '測試前提：非 BMP 字元是單一碼位');
    const d = keyDescriptor(c);
    assert.ok(d, `${c} 必須仍有描述子`);
    assert.equal(d.key, c);
    assert.equal(d.text, c);
    assert.equal(d.code, null);
    assert.equal(d.vk, c.codePointAt(0));
    assert.ok(d.vk < 0xd800 || d.vk > 0xdfff, `${c} 的 vk 不得落在代理區`);
  }
  assert.deepEqual(parseChord('Shift+😀'), { modifiers: ['Shift'], main: '😀' });
});

test('既有字元、具名鍵與 chord 行為不變（本次只擋代理碼元）', () => {
  assert.deepEqual(keyDescriptor('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.deepEqual(keyDescriptor('7'), { key: '7', code: 'Digit7', vk: 55, text: '7' });
  assert.deepEqual(keyDescriptor(' '), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  assert.deepEqual(keyDescriptor('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  assert.equal(keyDescriptor('F1').vk, 112);

  // BMP 非 ASCII 與多碼位大寫字元：code 為 null，行為不變
  assert.equal(keyDescriptor('é').code, null);
  assert.equal(keyDescriptor('é').vk, 201);
  assert.equal(keyDescriptor('é').text, 'é');
  assert.equal(keyDescriptor('中').code, null);
  assert.equal(keyDescriptor('ß').code, null);

  // 未知鍵與非字串輸入的既有契約
  assert.equal(keyDescriptor(''), null);
  assert.equal(keyDescriptor('ab'), null);
  assert.equal(keyDescriptor('NotAKey'), null);
  assert.equal(keyDescriptor('toString'), null);
  assert.throws(() => keyDescriptor(undefined), TypeError);
  assert.throws(() => keyDescriptor(null), TypeError);

  // 修飾鍵與 chord 解析不受影響
  assert.equal(isModifier('Shift'), true);
  assert.equal(modifierBit('Shift'), 8);
  assert.equal(isModifier('\uD83D'), false);
  assert.equal(modifierBit('\uD83D'), 0);
  assert.deepEqual(parseChord(' Shift + Tab '), { modifiers: ['Shift'], main: 'Tab' });
  assert.deepEqual(parseChord('ControlOrMeta+a'), { modifiers: ['ControlOrMeta'], main: 'a' });
});
