import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const agentSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../daemon/inpage.agent.js'),
  'utf8',
);

// Select and options are created in the same vm realm as the agent so option
// identity matches the browser. The value setter mirrors HTMLSelectElement:
// assigning .value selects the first option with that value.
function selectSameValue(pick) {
  const prelude = `
    const options = [
      { value: 'us', textContent: 'United States', selected: false },
      { value: 'us', textContent: 'USA', selected: false },
    ];
    const el = {
      tagName: 'SELECT',
      id: '',
      multiple: false,
      disabled: false,
      textContent: 'United States USA',
      getAttribute() { return null; },
      getBoundingClientRect() {
        return { left: 8, top: 8, width: 160, height: 24, right: 168, bottom: 32 };
      },
      options,
      dispatchEvent() {},
      get value() {
        const hit = options.find((o) => o.selected);
        return hit ? hit.value : '';
      },
      set value(v) {
        let taken = false;
        for (const o of options) {
          const on = !taken && o.value === v;
          o.selected = on;
          if (on) taken = true;
        }
      },
    };
    const window = {
      innerWidth: 1024,
      innerHeight: 768,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block', opacity: '1' };
      },
    };
    const document = {
      documentElement: { clientWidth: 1024, clientHeight: 768 },
      querySelectorAll(sel) { return sel === 'select' ? [el] : []; },
      querySelector() { return null; },
      getElementById() { return null; },
      title: '',
    };
    globalThis.window = window;
    globalThis.document = document;
  `;
  const epilogue = `
    const resolved = window.__egoAgent.resolve('select');
    if (resolved.hid == null) throw new Error('resolve failed: ' + JSON.stringify(resolved));
    const result = window.__egoAgent.selectOptions(resolved.hid, ${JSON.stringify(pick)});
    JSON.stringify({
      ok: result.ok,
      selected: result.selected,
      flags: options.map((o) => o.selected),
      selectedIndex: el.selectedIndex,
    });
  `;
  const sandbox = vm.createContext({
    Event,
    CSS: { escape: (s) => s },
    XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 },
  });
  const raw = vm.runInContext(`${prelude}\n${agentSrc}\n${epilogue}`, sandbox);
  return JSON.parse(raw);
}

test('selectOptions by visible label keeps the later option when values collide', () => {
  const out = selectSameValue('USA');
  assert.equal(out.ok, true);
  assert.deepEqual(out.selected, ['us']);
  assert.deepEqual(out.flags, [false, true]);
  assert.equal(out.selectedIndex, 1);
});

test('selectOptions by index keeps that option when an earlier one shares its value', () => {
  const out = selectSameValue(1);
  assert.equal(out.ok, true);
  assert.deepEqual(out.selected, ['us']);
  assert.deepEqual(out.flags, [false, true]);
  assert.equal(out.selectedIndex, 1);
});
