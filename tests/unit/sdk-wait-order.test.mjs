import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

test('waitForEvent registers waitPush before _refresh', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../lib/sdk.js'), 'utf8');
  const fn = src.slice(src.indexOf('async waitForEvent'), src.indexOf('async waitForFileChooser'));
  const waitAt = fn.indexOf('waitPush');
  const refreshAt = fn.indexOf('await this._refresh()');
  assert.ok(waitAt >= 0 && refreshAt > waitAt, 'waitPush must be armed before await _refresh');
  assert.equal(fn.includes('m.kind === \'download\' && m.kind === \'download\''), false);
});
