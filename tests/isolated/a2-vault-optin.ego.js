// RG-A2 (part 1): create a session cookie + localStorage; run-linux.sh then checks via CDP that the
// cookie is still a session cookie and that no vault files were written (unless TP_SESSION_VAULT=1).
const t = await taskSpace('rg-a2');
const p = t.page('p1');
await p.goto('http://127.0.0.1:8899/', { waitUntil: 'load' });
await p.evaluate(() => { document.cookie = 'tp_a2_sess=fixture; path=/'; localStorage.setItem('tp_a2_ls', 'fixture'); });
await new Promise((r) => setTimeout(r, 5000)); // > two vault sweep ticks
console.log('INFO A2 fixture cookie set, waited 5s for sweeps');
await t.finish();
