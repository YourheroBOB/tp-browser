// Smoke script — run with:  ego-browser nodejs -e "$(cat tests/smoke.ego.js)"
// Exercises the ego-browser compatible surface end to end.
const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const smokePort = process.env.EGO_SMOKE_PORT || process.env.TP_FIXTURE_PORT || '8899';
const BASE = `http://127.0.0.1:${smokePort}/`;
const smokeDir = process.env.EGO_SMOKE_DIR || mkdtempSync(join(tmpdir(), 'tp-smoke-'));
const shotPath = join(smokeDir, `shot-${process.pid}.png`);
const dlPath = join(smokeDir, `dl-${process.pid}.txt`);
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
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
const shot = await page.screenshot({ path: shotPath });
let pngOk = false;
try {
  const buf = readFileSync(shotPath);
  pngOk = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
} catch {}
check('screenshot', shot === shotPath && existsSync(shotPath) && pngOk, shotPath);

// download
const dlPromise = page.waitForEvent('download', { timeout: 10000 });
await page.click('#dl');
const dl = await dlPromise;
check('download suggested name', (await dl.suggestedFilename()) === 'smoke.txt');
await dl.saveAs(dlPath);
check('download saved', readFileSync(dlPath, 'utf8').includes('payload'));

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
