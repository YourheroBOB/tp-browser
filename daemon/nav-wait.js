// Decide whether the current document URL means this goto has finished.
// Exact path (slash-normalized). Prefix matches like /a vs /a/b are not "arrived".
// http↔https and trailing slash still count. A target query/hash must still match.

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

function normPath(pathname) {
  if (pathname === '/') return '/';
  return String(pathname || '/').replace(/\/+$/, '') || '/';
}

export function navigationReached(currentHref, targetHref) {
  let cur;
  let target;
  try {
    cur = new URL(currentHref);
    target = new URL(targetHref);
  } catch {
    return false;
  }
  const httpish = (p) => p === 'http:' || p === 'https:';
  if (!httpish(cur.protocol) || !httpish(target.protocol)) {
    if (cur.protocol !== target.protocol) return false;
  }
  if (cur.hostname !== target.hostname) return false;
  const curPort = cur.port || defaultPort(cur.protocol);
  const targetPort = target.port || defaultPort(target.protocol);
  const defaultHttpPorts = (cur.port === '' && target.port === '' && httpish(cur.protocol) && httpish(target.protocol));
  if (!defaultHttpPorts && curPort !== targetPort) return false;
  if (normPath(cur.pathname) !== normPath(target.pathname)) return false;
  // If the target asked for a query/hash, require it. An empty current search
  // must not count as arrived (that would accept goto('/?z') while still on '/').
  if (target.search && cur.search !== target.search) return false;
  if (target.hash && cur.hash !== target.hash) return false;
  return true;
}
