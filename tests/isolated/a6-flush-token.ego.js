// RG-A6: /flush-and-close without the token must be refused and must not close the browser.
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} A6 ${n}${x ? ' — ' + x : ''}`); if (!c) process.exitCode = 1; };
const DP = process.env.EGO_BROWSERD_PORT, CP = process.env.EGO_CHROME_PORT;
const r1 = await fetch(`http://127.0.0.1:${DP}/flush-and-close`);
ok('no token -> 403', r1.status === 403, String(r1.status));
const r2 = await fetch(`http://127.0.0.1:${DP}/flush-and-close`, { headers: { 'x-tp-token': 'wrong-token-value' } });
ok('wrong token -> 403', r2.status === 403, String(r2.status));
await new Promise((r) => setTimeout(r, 500));
const alive = await fetch(`http://127.0.0.1:${CP}/json/version`).then((r) => r.ok).catch(() => false);
ok('browser still alive', alive);
