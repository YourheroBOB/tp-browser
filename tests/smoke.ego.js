const FX = 'http://127.0.0.1:' + ((typeof process !== 'undefined' && process.env.TP_FIXTURE_PORT) || 8899) + '/';
// Smoke script — run with:  ego-browser nodejs -e "$(cat tests/smoke.ego.js)"
// Exercises the ego-browser compatible surface end to end.
const BASE = FX;
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const task = await taskSpace('ego-linux smoke');
const page = task.page('p1');
check('space created', typeof task.spaceId === 'number' && task.ownership === 'agent', `id=${task.spaceId}`);

await page.goto(BASE, { waitUntil: 'load' });
check('goto', (await page.url()).startsWith(BASE));
check('title', (await page.title()).includes('smoke'));

const info = await page.info();
check('info keys', info && info.w > 0 && 'sx' in info && 'ph' in info, JSON.stringify(info).slice(0, 80));

const snap = await page.snapshot();
check('snapshot header', snap.startsWith('[p1 "'), snap.split('\n')[0]);
check('snapshot roles', snap.includes('heading') && snap.includes('paragraph') && snap.includes('button'));
check('snapshot anchor ref', /anchor \[ref=\d+/.test(snap));

await page.fill('#name', '嚴柏顯');
check('fill', await page.evaluate(() => document.getElementById('name').value) === '嚴柏顯');

const sel = await page.selectOption('#city', { label: '台中' });
check('selectOption', (await page.evaluate(() => document.getElementById('city').value)) === 'txg', JSON.stringify(sel));

await page.click('text=問候');
check('click', await page.waitForFunction(() => document.getElementById('out').textContent.length > 0, undefined, { timeout: 5000 }));
check('click effect', (await page.evaluate(() => document.getElementById('out').textContent)).includes('嚴柏顯'));

await page.press('#name', 'ControlOrMeta+a');
await page.keyboard.type('XY');
check('press+type', await page.evaluate(() => document.getElementById('name').value) === 'XY');

// dialog
const clickP = page.click('#alerter');
await new Promise((r) => setTimeout(r, 300));
const dlg = await page.info().then((i) => i.dialog);
check('dialog surfaced', !!dlg, dlg ? dlg.message : 'no dialog');
check('acceptDialog', (await page.acceptDialog()) === true);

// evaluate with arg
const doubled = await page.evaluate(({ x }) => x * 2, { x: 21 });
check('evaluate arg', doubled === 42);

// popup
const popupPromise = page.waitForEvent('popup', { timeout: 8000 });
await page.click('#popup-link');
const popup = await popupPromise;
check('popup page', !!popup && typeof popup.label === 'string', `label=${popup?.label}`);
await popup.close();

// screenshot (path write)
const shot = await page.screenshot({ path: '/tmp/ego-linux-smoke.png' });
check('screenshot', shot === '/tmp/ego-linux-smoke.png');

// download
const dlPromise = page.waitForEvent('download', { timeout: 10000 });
await page.click('#dl');
const dl = await dlPromise;
check('download suggested name', (await dl.suggestedFilename()) === 'smoke.txt');
await dl.saveAs('/tmp/ego-linux-smoke-dl.txt');
const { readFileSync } = await import('node:fs');
check('download saved', readFileSync('/tmp/ego-linux-smoke-dl.txt', 'utf8').includes('payload'));

// error wording parity
let errName = '', errMsg = '';
try { await page.click('text=不存在的按鈕', { timeout: 1200 }); }
catch (e) { errName = e.name; errMsg = e.message; }
check('error wording', errName === 'ElementResolutionError' && /page\.click timed out after \d+ms: Locator .+ matched 0 elements/.test(errMsg), errMsg);

// waitForSelector
await page.waitForSelector('#out', { state: 'visible', timeout: 3000 });
check('waitForSelector', true);

// second page + tabs + finish keep
const p2 = await task.newPage();
await p2.goto(BASE);
const tabs = await task.tabs();
check('tabs two managed', tabs.filter((t) => t.label).length === 2);
const fin = await task.finish({ keep: [] });
check('finish closes', Array.isArray(fin.closed) && fin.closed.length === 2, JSON.stringify(fin));

const failed = results.filter((r) => !r.pass);
console.log(`\n== smoke: ${results.length - failed.length}/${results.length} pass ==`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); }
else { console.log('ALL_GREEN'); }
