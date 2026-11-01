// text=… >> nth=N 與 css/cssText 的負數 nth。
// 用 node:vm 載入 daemon/inpage.agent.js 原文與最小假 DOM。零網路、不寫 repo 以外路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const agentSrc = readFileSync(fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)), 'utf8');

function button(text, x, y) {
  return {
    nodeType: 1,
    tagName: 'BUTTON',
    textContent: text,
    childNodes: [{ nodeType: 3, textContent: text }],
    disabled: false,
    getAttribute() { return null; },
    getBoundingClientRect() {
      return { left: x, top: y, right: x + 48, bottom: y + 24, width: 48, height: 24 };
    },
  };
}

function install(elements) {
  const sandbox = {
    innerWidth: 1280,
    innerHeight: 720,
    getComputedStyle() {
      return { visibility: 'visible', display: 'block', opacity: '1' };
    },
    document: {
      documentElement: { clientWidth: 1280, clientHeight: 720 },
      querySelectorAll(selector) {
        if (selector === 'button') return elements.filter((el) => el.tagName === 'BUTTON');
        return elements.slice();
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const status = vm.runInContext(agentSrc, sandbox);
  assert.equal(status, 'installed');
  assert.equal(typeof sandbox.__egoAgent.resolve, 'function');
  return sandbox.__egoAgent;
}

test('兩個 Item button：text=Item >> nth=1 是第二個，css=button >> nth=-1 是最後一個', () => {
  const agent = install([button('Item', 10, 16), button('Item', 10, 64)]);

  const both = agent.resolve('text=Item');
  assert.equal(both.count, 2);
  assert.equal(both.hid, null);

  const nth0 = agent.resolve('text=Item >> nth=0');
  assert.equal(nth0.count, 1);
  assert.equal(nth0.error, null);
  assert.equal(nth0.d.tag, 'button');
  assert.equal(nth0.d.text, 'Item');
  assert.equal(nth0.d.y, 16);

  const nth1 = agent.resolve('text=Item >> nth=1');
  assert.equal(nth1.count, 1);
  assert.equal(nth1.error, null);
  assert.equal(nth1.d.tag, 'button');
  assert.equal(nth1.d.text, 'Item');
  assert.equal(nth1.d.x, 10);
  assert.equal(nth1.d.y, 64);

  const quoted = agent.resolve('text="Item" >> nth=1');
  assert.equal(quoted.count, 1);
  assert.equal(quoted.d.y, 64);

  const textLast = agent.resolve('text=Item >> nth=-1');
  assert.equal(textLast.count, 1);
  assert.equal(textLast.d.y, 64);

  const cssLast = agent.resolve('css=button >> nth=-1');
  assert.equal(cssLast.count, 1);
  assert.equal(cssLast.error, null);
  assert.equal(cssLast.d.tag, 'button');
  assert.equal(cssLast.d.y, 64);
});

test('三個 Item button：nth=1 是第二個，nth=-1 是最後一個（css 與 cssText）', () => {
  const agent = install([
    button('Item', 10, 16),
    button('Item', 10, 64),
    button('Item', 10, 112),
  ]);

  const nth1 = agent.resolve('text=Item >> nth=1');
  assert.equal(nth1.count, 1);
  assert.equal(nth1.d.y, 64);

  const textLast = agent.resolve('text=Item >> nth=-1');
  assert.equal(textLast.count, 1);
  assert.equal(textLast.d.y, 112);

  const cssLast = agent.resolve('css=button >> nth=-1');
  assert.equal(cssLast.count, 1);
  assert.equal(cssLast.d.y, 112);

  const cssTextLast = agent.resolve('css=button:has-text("Item") >> nth=-1');
  assert.equal(cssTextLast.count, 1);
  assert.equal(cssTextLast.error, null);
  assert.equal(cssTextLast.d.y, 112);

  const missing = agent.resolve('css=button >> nth=-4');
  assert.equal(missing.count, 0);
  assert.equal(missing.hid, null);
});
