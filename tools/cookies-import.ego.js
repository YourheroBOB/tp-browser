// Import cookies from a fixed JSON path (as written by cookies-export.ego.js).
// The source path is a constant by design; relocate via symlink, not env vars.
// usage: cp your-cookies.json /tmp/ego-cookies.json
//        ego-browser nodejs < tools/cookies-import.ego.js
const { readFileSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');
const { homedir } = await import('node:os');
// Fixed inputs: ~/.local/share/ego-linux/ego-cookies.json or /tmp/ego-cookies.json
const HOME_IN = join(homedir(), '.local', 'share', 'ego-linux', 'ego-cookies.json');
const IN = existsSync(HOME_IN) ? HOME_IN : '/tmp/ego-cookies.json';
const task = await taskSpace('cookies-import');
const page = task.page('p1');
const data = JSON.parse(readFileSync(IN, 'utf8'));
let ok = 0; const failed = [];
for (const c of data.cookies) {
  const scheme = c.secure ? 'https' : 'http';
  const host = String(c.domain || '').startsWith('.') ? String(c.domain).slice(1) : (c.domain || '');
  const params = {
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    secure: !!c.secure, httpOnly: !!c.httpOnly,
    sameSite: c.sameSite === 'None' ? 'None' : (c.sameSite === 'Strict' ? 'Strict' : (c.sameSite === 'Lax' ? 'Lax' : undefined)),
    url: `${scheme}://${host}${c.path || '/'}`,
  };
  if (c.expires && c.expires > 0) params.expiresAt = c.expires; // epoch seconds
  try { await page.cdp('Network.setCookie', params); ok++; } catch (e) { failed.push(`${c.domain} ${c.name}: ${e.message}`); }
}
await task.finish({ keep: [] });
console.log(JSON.stringify({ imported: ok, failed: failed.length, failures: failed.slice(0, 5) }, null, 1));
