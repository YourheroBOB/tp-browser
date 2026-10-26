import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOnly, shouldBufferCdpEvent } from '../../daemon/redact.js';

test('hostOnly strips query', () => {
  assert.equal(hostOnly('https://example.test/path?code=fixture#x'), 'https://example.test');
  assert.doesNotMatch(hostOnly('https://example.test/?code=fixture'), /code=fixture/);
});

test('shouldBufferCdpEvent drops Network and ExtraInfo', () => {
  assert.equal(shouldBufferCdpEvent('Network.responseReceived'), false);
  assert.equal(shouldBufferCdpEvent('Network.requestWillBeSentExtraInfo'), false);
  assert.equal(shouldBufferCdpEvent('Page.lifecycleEvent'), true);
});
