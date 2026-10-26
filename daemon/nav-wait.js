// Decide whether the current document URL means this goto has finished.

export function navigationReached(currentHref, targetHref) {
  let cur;
  let target;
  try {
    cur = new URL(currentHref);
    target = new URL(targetHref);
  } catch {
    return false;
  }
  if (cur.protocol !== target.protocol) return false;
  if (cur.hostname !== target.hostname) return false;
  const curPort = cur.port || (cur.protocol === 'https:' ? '443' : '80');
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (curPort !== targetPort) return false;
  const targetHasSearchOrHash = target.search !== '' || target.hash !== '';
  if (targetHasSearchOrHash) {
    return cur.pathname === target.pathname && cur.search === target.search && cur.hash === target.hash;
  }
  if (cur.pathname === target.pathname) return true;
  const prefix = target.pathname.replace(/\/$/, '') + '/';
  if (prefix === '/') return false;
  return cur.pathname.startsWith(prefix);
}
