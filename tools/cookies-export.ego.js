// Export all browser cookies (login state) as JSON to stdout.
// usage: ego-browser nodejs < tools/cookies-export.ego.js > cookies.json
// Cookies include httpOnly session cookies (via CDP Storage.getCookies).
const task = await taskSpace('cookies-export');
const page = task.page('p1');
const all = await task.cdp('Storage.getCookies', {});
const cookies = (all.cookies || []).map((c) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path,
  expires: c.expires || -1, size: c.size, httpOnly: !!c.httpOnly,
  secure: !!c.secure, sameSite: c.sameSite || undefined, priority: c.priority,
  sourceScheme: c.sourceScheme, sourcePort: c.sourcePort,
}));
await task.finish({ keep: [] });
console.log(JSON.stringify({ exportedAt: new Date().toISOString(), count: cookies.length, cookies }, null, 1));
console.error(`exported ${cookies.length} cookies`);
