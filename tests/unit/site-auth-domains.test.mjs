import test from 'node:test';
import assert from 'node:assert/strict';
import { collectResetDomains, cookieDomainMatches } from '../../daemon/site-auth-domains.js';

test('notoffice.example does not pull microsoft.com or example', () => {
  const set = collectResetDomains('notoffice.example');
  assert.equal(set.has('notoffice.example'), true);
  assert.equal(set.has('microsoft.com'), false);
  assert.equal(set.has('example'), false);
  assert.equal(set.has('office.com'), false);
  assert.equal(cookieDomainMatches('microsoft.com', set), false);
});

test('login.microsoft.com pulls microsoft family suffixes', () => {
  const set = collectResetDomains('login.microsoft.com');
  assert.equal(set.has('microsoft.com'), true);
  assert.equal(set.has('live.com'), true);
  assert.equal(cookieDomainMatches('.login.microsoft.com', set), true);
});
