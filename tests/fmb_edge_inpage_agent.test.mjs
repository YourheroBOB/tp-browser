import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const agentSource = readFileSync(
  new URL('../daemon/inpage.agent.js', import.meta.url),
  'utf8',
);

function newAgentContext() {
  return {
    window: {
      innerWidth: 800,
      innerHeight: 600,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block', opacity: '1' };
      },
    },
    document: {
      title: 'Edge fixture',
      documentElement: {
        clientWidth: 800,
        clientHeight: 600,
        scrollWidth: 800,
        scrollHeight: 600,
      },
      querySelectorAll(selector) {
        if (selector === '[') {
          throw new SyntaxError('fixture invalid selector');
        }
        return [];
      },
      getElementById() {
        return null;
      },
      evaluate() {
        return { snapshotLength: 0 };
      },
    },
    location: { href: 'https://example.invalid/fmb-edge' },
    CSS: {
      escape(value) {
        return String(value);
      },
    },
  };
}

test('browser agent reports malformed and invalid selectors as invalid selector', () => {
  const context = newAgentContext();
  assert.equal(runInNewContext(agentSource, context), 'installed');
  const agent = context.window.__egoAgent;

  const malformedSelectors = [
    'loc=role:',
    'loc=role:button[broken',
    'css=button:has-text("unterminated',
    "css=button:text-is('unterminated",
    '[',
  ];

  for (const selector of malformedSelectors) {
    const result = agent.resolve(selector);
    assert.equal(result.count, 0);
    assert.equal(result.hid, null);
    assert.equal(result.error, 'invalid selector');
  }

  const missingReference = agent.resolve('@999999');
  assert.equal(missingReference.count, 0);
  assert.equal(missingReference.hid, null);
  assert.equal(missingReference.error, null);
});

test('browser agent returns explicit errors for stale element handles', () => {
  const context = newAgentContext();
  runInNewContext(agentSource, context);
  const agent = context.window.__egoAgent;

  const fill = agent.fillValue(999999, 'FAKE_VALUE_FOR_TEST');
  assert.equal(fill.ok, false);
  assert.equal(fill.error, 'stale handle');

  assert.equal(agent.checkValue(999999, 'FAKE_VALUE_FOR_TEST'), false);

  const selection = agent.selectOptions(999999, []);
  assert.equal(selection.ok, false);
  assert.equal(selection.error, 'not a select');

  assert.equal(agent.focusEl(999999).ok, false);
  assert.equal(agent.markForDom(999999), null);
  assert.equal(agent.fileInfo(999999), null);

  const position = agent.ensureVisible(999999);
  assert.equal(position.cx, 0);
  assert.equal(position.cy, 0);
  assert.equal(position.x, 0);
  assert.equal(position.y, 0);
  assert.equal(position.w, 0);
  assert.equal(position.h, 0);
});

test('browser agent rejects an invalid subtree root without traversing the document', () => {
  const context = newAgentContext();
  runInNewContext(agentSource, context);
  const agent = context.window.__egoAgent;

  const snapshot = agent.snap({ scope: 'subtree', rootRef: 999999 });
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0], '(invalid subtree root ref)');
  assert.equal(snapshot.title, 'Edge fixture');
  assert.equal(snapshot.url, 'https://example.invalid/fmb-edge');
});

test('browser agent injection is idempotent and preserves an existing installation', () => {
  const context = newAgentContext();
  const existing = { sentinel: true };
  context.window.__egoAgent = existing;

  assert.equal(runInNewContext(agentSource, context), 'reuse');
  assert.equal(context.window.__egoAgent, existing);
  assert.equal(context.window.__egoAgent.sentinel, true);
});
