// Export all browser cookies (login state) as JSON to ~/.local/share/ego-linux/cookies.json (mode 0600).
// usage: tp-browser nodejs < tools/cookies-export.ego.js
// Cookies include httpOnly session cookies (via CDP Storage.getCookies).
const { writeFileSync, mkdirSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { homedir } = await import('node:os');
const OUT = process.env.TP_COOKIES_FILE || process.env.EGO_COOKIES_FILE || join(homedir(), '.local', 'share', 'ego-linux', 'cookies.json');
const task = await taskSpace('cookies-export');
const page = task.page('p1');
const all = await page.cdp('Storage.getCookies', {});
const cookies = (all.cookies || []).map((c) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path,
  expires: c.expires || -1, size: c.size, httpOnly: !!c.httpOnly,
  secure: !!c.secure, sameSite: c.sameSite || undefined, priority: c.priority,
  sourceScheme: c.sourceScheme, sourcePort: c.sourcePort,
  ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
}));
await task.finish({ keep: [] });
mkdirSync(dirname(OUT), { recursive: true, mode: 0o700 });
writeFileSync(OUT, JSON.stringify({ exportedAt: new Date().toISOString(), count: cookies.length, cookies }, null, 1), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, count: cookies.length, path: OUT }));
