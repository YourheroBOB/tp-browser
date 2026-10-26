// Host / Origin gate and RPC body-size response (must run before any route).

export const RPC_MAX_BODY = 1048576;

export function isForbiddenHostOrigin(headers = {}) {
  if (headers.origin) return true;
  if (!/^127\.0\.0\.1(:\d+)?$/.test(headers.host || '')) return true;
  return false;
}

export function rpcTooLargePayload() {
  return JSON.stringify({
    ok: false,
    error: { name: 'BadRequest', message: `request body too large (max ${RPC_MAX_BODY} bytes)` },
  });
}
