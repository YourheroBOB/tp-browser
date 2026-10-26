const FX = 'http://127.0.0.1:' + ((typeof process !== 'undefined' && process.env.TP_FIXTURE_PORT) || 8899) + '/';
// RG-A3: TaskSpace.closePage(label) must close the browser tab, release(label) must keep it.
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} A3 ${n}${x ? ' — ' + x : ''}`); if (!c) process.exitCode = 1; };
const CP = process.env.EGO_CHROME_PORT;
const targets = async () => (await (await fetch(`http://127.0.0.1:${CP}/json/list`)).json()).filter((t) => t.type === 'page').map((t) => t.id);
const t = await taskSpace('rg-a3');
const a = await t.newPage(); await a.goto(FX, { waitUntil: 'load' });
const b = await t.newPage(); await b.goto(FX, { waitUntil: 'load' });
ok('both tabs exist', (await targets()).includes(a.targetId) && (await targets()).includes(b.targetId));
await t.closePage(a.label);
await new Promise((r) => setTimeout(r, 500));
ok('closePage removed the tab', !(await targets()).includes(a.targetId), a.targetId);
ok('closePage removed ledger entry', !(await t.tabs()).some((x) => x.label === a.label));
await t.release(b.label);
ok('release kept the tab', (await targets()).includes(b.targetId));
ok('release removed ledger label', !(await t.tabs()).some((x) => x.label === b.label));
await fetch(`http://127.0.0.1:${CP}/json/close/${b.targetId}`).catch(() => {});
await t.finish();
