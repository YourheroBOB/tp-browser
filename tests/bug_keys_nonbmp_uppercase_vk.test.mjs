// keyDescriptor() 用 UTF-16 length 判斷「大寫是不是單一碼位」。
// 非 BMP 的單一碼位大寫（UTF-16 length === 2）被當成多碼位展開，
// vk 退回小寫自身碼位，而不是契約要求的大寫碼位（同 'é' → 'É'）。
// 純函式測試：不連網、不讀寫檔案、不使用任何憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor, parseChord } from '../daemon/keys.js';

// Deseret 小寫字母的大寫是另一個非 BMP 單碼位（UTF-16 長度為 2）。
const DESERET_SMALL = [0x10428, 0x10429];

test('非 BMP 單碼位大寫的 vk 必須是大寫碼位，不能退回小寫', () => {
  for (const cp of DESERET_SMALL) {
    const c = String.fromCodePoint(cp);
    const upper = c.toUpperCase();
    assert.notEqual(upper, c, `${c} 的大寫必須不同（測試前提）`);
    assert.equal([...upper].length, 1, `${c} 的大寫必須是單一碼位（測試前提）`);
    assert.ok(upper.length > 1, `${c} 的大寫必須是非 BMP（測試前提）`);

    const d = keyDescriptor(c);
    assert.ok(d, '必須有描述子');
    assert.equal(d.key, c);
    assert.equal(d.code, null, '非美式鍵盤字元沒有實體 code');
    assert.equal(d.text, c);
    assert.equal(d.vk, upper.codePointAt(0), 'vk 必須是大寫碼位');
    assert.notEqual(d.vk, c.codePointAt(0), 'vk 不得停留在小寫碼位');
  }
});

test('parseChord 主鍵沿用同一個 vk（Shift+該字元）', () => {
  const c = String.fromCodePoint(0x10428);
  const parsed = parseChord(`Shift+${c}`);
  assert.deepEqual(parsed, { modifiers: ['Shift'], main: c });
  assert.equal(keyDescriptor(parsed.main).vk, c.toUpperCase().codePointAt(0));
});
