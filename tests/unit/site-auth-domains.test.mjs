import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectResetDomains,
  cookieDomainMatches,
  registrableDomain,
} from '../../daemon/site-auth-domains.js';

function cookieCleared(host, cookieDomain) {
  return cookieDomainMatches(cookieDomain, collectResetDomains(host));
}

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

test('parent-domain cookies on ordinary sites are cleared', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(cookieCleared('www.example.com', '.example.com'), true);
  assert.equal(cookieCleared('app.example.com', 'example.com'), true);
  assert.equal(cookieCleared('www.example.com', '.other.com'), false);
});

test('office365.com is in the Microsoft family', () => {
  assert.equal(cookieCleared('outlook.office365.com', '.microsoftonline.com'), true);
  assert.equal(cookieCleared('outlook.office365.com', '.live.com'), true);
  assert.equal(collectResetDomains('outlook.office365.com').has('office365.com'), true);
});

test('google ccTLD cookies are cleared', () => {
  assert.equal(registrableDomain('www.google.com.tw'), 'google.com.tw');
  assert.equal(cookieCleared('www.google.com.tw', '.google.com'), true);
  assert.equal(cookieCleared('www.google.com.tw', '.google.com.tw'), true);
});

test('azurewebsites.net is a public suffix and still pulls Microsoft family', () => {
  assert.equal(registrableDomain('xyz.azurewebsites.net'), 'xyz.azurewebsites.net');
  assert.equal(cookieCleared('xyz.azurewebsites.net', '.microsoftonline.com'), true);
  assert.equal(cookieCleared('xyz.azurewebsites.net', '.other-app.azurewebsites.net'), false);
});
