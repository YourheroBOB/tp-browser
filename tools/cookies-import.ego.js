// Import cookies from TP_COOKIES_FILE / EGO_COOKIES_FILE or
// ~/.local/share/ego-linux/{cookies,ego-cookies}.json.
// No /tmp fallback. stdout prints counts only (no cookie name/value).
// usage: ego-browser nodejs < tools/cookies-import.ego.js
const { readFileSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');
const { homedir } = await import('node:os');
const DATA_DIR = join(homedir(), '.local', 'share', 'ego-linux');
const C1 = join(DATA_DIR, 'cookies.json');
const C2 = join(DATA_DIR, 'ego-cookies.json');
const envPath = process.env.TP_COOKIES_FILE || process.env.EGO_COOKIES_FILE;
let IN = null;
if (envPath && existsSync(envPath)) IN = envPath;
else if (existsSync(C1)) IN = C1;
else if (existsSync(C2)) IN = C2;
if (!IN) {
  const lines = [
    'cookie import failed: no source file found',
    `  TP_COOKIES_FILE/EGO_COOKIES_FILE: ${envPath ? (existsSync(envPath) ? 'exists' : 'missing') : '(unset)'}`,
    `  ${C1}: ${existsSync(C1) ? 'exists' : 'missing'}`,
    `  ${C2}: ${existsSync(C2) ? 'exists' : 'missing'}`,
  ];
  console.error(lines.join('\n'));
  process.exitCode = 1;
  process.exit(1);
}
const task = await taskSpace('cookies-import');
const page = task.page('p1');
const rawData = JSON.parse(readFileSync(IN, 'utf8'));
const cookieList = Array.isArray(rawData) ? rawData : (rawData.cookies || []);
let ok = 0; let failed = 0;
try {
  await page.cdp('Storage.setCookies', { cookies: cookieList });
  ok = cookieList.length;
} catch {
  for (const c of cookieList) {
    const scheme = c.secure ? 'https' : 'http';
    const host = String(c.domain || '').startsWith('.') ? String(c.domain).slice(1) : (c.domain || '');
    const params = {
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: c.sameSite === 'None' ? 'None' : (c.sameSite === 'Strict' ? 'Strict' : (c.sameSite === 'Lax' ? 'Lax' : undefined)),
      url: `${scheme}://${host}${c.path || '/'}`,
    };
    if (c.expires && c.expires > 0) params.expires = c.expires;
    if (c.partitionKey) params.partitionKey = c.partitionKey;
    try { await page.cdp('Network.setCookie', params); ok++; } catch { failed++; }
  }
}
await task.finish({ keep: [] });
console.log(JSON.stringify({ imported: ok, failed, source: IN }, null, 1));
