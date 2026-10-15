// Benchmark runner (ego-browser syntax): for each of the 10 structured pages,
// capture the two observation payloads an agent would receive per round:
//  - semantic snapshot text (ego / ego-linux route)
//  - viewport screenshot PNG (computer-use route)
// Writes measurements JSON to stdout.
const BASE = 'http://127.0.0.1:8890/';
const PAGES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
const NAMES = { p1: '長文章', p2: '複雜表單', p3: '資料表格', p4: '導覽樹', p5: '商品列表', p6: '搜尋結果', p7: '登入頁', p8: '儀表板', p9: '技術文件', p10: 'canvas畫布' };
const { statSync, writeFileSync } = await import('node:fs');

const task = await taskSpace('bench run');
const page = task.page('p1');
const rows = [];
for (const key of PAGES) {
  await page.goto(BASE + key, { waitUntil: 'load', timeout: 20000 });
  const snap = await page.snapshot({ scope: 'only_within_viewport' });
  const shotPath = `/tmp/bench-${key}.png`;
  await page.screenshot({ path: shotPath });
  const bytes = statSync(shotPath).size;
  writeFileSync(`/tmp/bench-${key}.snap.txt`, snap, 'utf8');
  rows.push({
    page: key,
    name: NAMES[key],
    snapChars: snap.length,
    snapLines: snap.split('\n').length,
    pngBytes: bytes,
    snapHead: snap.split('\n')[0].slice(0, 80),
  });
  console.error(`measured ${key} ${NAMES[key]}: ${snap.length} chars, ${bytes} png bytes`);
}
await task.finish({ keep: [] });
console.log(JSON.stringify({ rows, viewport: '1440x900', date: new Date().toISOString() }, null, 1));
