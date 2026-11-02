// Regression test for shared named-key descriptors being mutable.
// Mutating a returned descriptor must not corrupt future key lookups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyDescriptor } from '../daemon/keys.js';

test('named key descriptors cannot be mutated to corrupt later lookups', () => {
  const enter = keyDescriptor('Enter');

  assert.equal(Object.isFrozen(enter), true);
  assert.equal(Reflect.set(enter, 'vk', 65), false);
  assert.equal(keyDescriptor('Enter').vk, 13);
});
