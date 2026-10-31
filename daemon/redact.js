// Strip query / fragment from URLs shown to agents or written to logs.

export function hostOnly(url) {
  if (typeof url !== 'string' || url.length === 0) return '[no-url]';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[invalid-url]';
  }
}

export function loopbackPortLabel(port) {
  return `127.0.0.1:${port}`;
}

export function shouldBufferCdpEvent(method) {
  const m = String(method || '');
  if (!m) return false;
  if (m.startsWith('Network.')) return false;
  if (m.endsWith('ExtraInfo')) return false;
  return true;
}
