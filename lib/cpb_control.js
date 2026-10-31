import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildSdk, EgoError } from './sdk.js';

const MAX_DELAY = 2 ** 31 - 1;

function checkDelay(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DELAY) {
    throw new TypeError(`${name} must be an integer between 1 and ${MAX_DELAY} milliseconds`);
  }
}

export async function waitForControl(task, listTaskSpaces, {
  timeout = 30000,
  polling = 150,
  signal,
} = {}) {
  const id = typeof task === 'number' ? task : task?.spaceId;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError('task must be a TaskSpace or a positive integer space ID');
  }
  if (typeof listTaskSpaces !== 'function') {
    throw new TypeError('listTaskSpaces must be a function');
  }
  checkDelay(timeout, 'timeout');
  checkDelay(polling, 'polling');
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (signal?.aborted) throw new EgoError('AbortError', 'waitForControl was aborted');

  const stop = new AbortController();
  const deadline = performance.now() + timeout;
  const timeoutError = new EgoError('TimeoutError', `waitForControl timed out after ${timeout}ms for task space ${id}`);
  const abort = () => stop.abort(new EgoError('AbortError', 'waitForControl was aborted'));
  const stopped = new Promise((_, reject) => {
    stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true });
  });
  const timer = setTimeout(() => stop.abort(timeoutError), timeout);
  signal?.addEventListener('abort', abort, { once: true });

  function checkStopped() {
    if (performance.now() >= deadline && !stop.signal.aborted) stop.abort(timeoutError);
    stop.signal.throwIfAborted();
  }

  async function poll() {
    for (;;) {
      checkStopped();
      // space.use changes state and creates targets; space.list is observation only.
      const spaces = await listTaskSpaces();
      checkStopped();
      if (!Array.isArray(spaces)) {
        throw new EgoError('ProtocolError', 'space.list must return an array');
      }
      const space = spaces.find((entry) => entry?.id === id);
      if (!space) throw new EgoError('UnknownSpace', `no task space ${id}`);
      if (!['agent', 'user'].includes(space.ownership) ||
          !['active', 'handed-off'].includes(space.state)) {
        throw new EgoError('ProtocolError', `invalid control state for task space ${id}`);
      }
      if (space.ownership === 'agent' && space.state === 'active') return { control: true };
      await sleep(polling, undefined, { signal: stop.signal });
    }
  }

  try {
    // Bound the whole wait, including a daemon request that never settles.
    return await Promise.race([poll(), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function buildControlSdk(client) {
  const sdk = buildSdk(client);
  // buildSdk creates fresh classes, so this opt-in override cannot affect other SDKs.
  sdk.TaskSpace.prototype.waitForControl = async function (options = {}) {
    const receipt = await waitForControl(this, sdk.listTaskSpaces, options);
    this.ownership = 'agent';
    this._state = 'active';
    return receipt;
  };
  return sdk;
}
