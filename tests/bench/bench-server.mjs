// Benchmark server: 10 differently-structured pages on 127.0.0.1:8890
// /p1../p10 and /download. Used by bench-run.ego.js to measure observation
// payload size (snapshot text vs screenshot PNG) per page structure.
import { createServer } from 'node:http';

const page = (title, body) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const para = (i) => `<p>第${i}段：人工智慧代理在法律事務所的日常工作中，需要閱讀大量結構各異的網頁。本段文字用於模擬真實文章密度，包含術語如卷證、書狀、言詞辯論、證據能力，以及數字 1,248 與日期 1151015 等混合內容，以逼近實際 token 分佈。</p>`;

const PAGES = {
  p1: page('長文章', `<main><h1>深度報告：代理人流程自動化</h1>${Array.from({ length: 24 }, (_, i) => para(i + 1)).join('')}</main>`),
  p2: page('複雜表單', `<form><h1>當事人資料表</h1>${Array.from({ length: 12 }, (_, i) => `<label for="f${i}">欄位${i + 1}（類型${(i % 4) + 1}）</label><input id="f${i}" name="f${i}" type="${['text', 'date', 'email', 'tel'][i % 4]}" placeholder="請輸入欄位${i + 1}">`).join('')}<label for="memo">備註</label><textarea id="memo" rows="4"></textarea><button type="submit">送出</button><button type="reset">重設</button></form>`),
  p3: page('資料表格', `<h1>年度收支明細</h1><table border="1"><thead><tr>${['月份', '收入', '支出', '淨額', '憑證數', '狀態', '承辦', '備註'].map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: 16 }, (_, i) => `<tr><td>${i + 1}月</td><td>${(120000 + i * 3311).toLocaleString()}</td><td>${(80000 + i * 2117).toLocaleString()}</td><td>${(40000 + i * 1194).toLocaleString()}</td><td>${3 + (i % 7)}</td><td>${['已核', '待核', '爭議'][i % 3]}</td><td>同事${String.fromCharCode(65 + (i % 6))}</td><td>備註 ${i + 1}</td></tr>`).join('')}</tbody></table>`),
  p4: page('導覽樹', `<nav><h1>知識庫目錄</h1>${Array.from({ length: 6 }, (_, i) => `<details open><summary>第${i + 1}類：法律領域${i + 1}</summary><ul>${Array.from({ length: 5 }, (_, j) => `<li><a href="#s${i}-${j}">${i + 1}.${j + 1} 子分類條目（含司法解释與判例）</a></li>`).join('')}</ul></details>`).join('')}</nav>`),
  p5: page('商品列表', `<h1>精選商品</h1><div class="grid">${Array.from({ length: 24 }, (_, i) => `<article><h2>商品 ${i + 1}：辦公自動化週邊 ${i + 1} 號</h2><p>價格 NT$${(990 + i * 137).toLocaleString()}｜評價 ${(4 + (i % 10) / 10)} 星｜庫存 ${i % 5 === 0 ? '缺貨' : '有'}</p><button>加入購物車</button></article>`).join('')}</div>`),
  p6: page('搜尋結果', `<h1>「勞動基準法 加班費」搜尋結果</h1>${Array.from({ length: 10 }, (_, i) => `<section><a href="#r${i}">結果 ${i + 1}：加班費計算標準與實務見解整理（第 ${i + 1} 篇）</a><p>摘要在請求權、舉證責任與裁判費計算上，實務見解…本結果用於模擬搜尋引擎版面。</p><cite>example-${i + 1}.law</cite></section>`).join('')}<aside><h2>篩選器</h2>${['年份', '法院層級', '判決類型', '全文/標題'].map((f) => `<label>${f}<select><option>全部</option><option>近一年</option></select></label>`).join('')}</aside>`),
  p7: page('登入', `<main><h1>系統登入</h1><form><label>帳號<input type="text" name="u"></label><label>密碼<input type="password" name="p"></label><label><input type="checkbox" name="r"> 記住此裝置</label><button>登入</button><a href="#f">忘記密碼？</a></form></main>`),
  p8: page('儀表板', `<h1>營運儀表板</h1><section><h2>KPI</h2>${['進行中案件 128', '本月新收 17', '待覆核 9', '逾期警示 2'].map((k) => `<div><strong>${k.split(' ')[0]}</strong><span>${k.split(' ').slice(1).join(' ')}</span></div>`).join('')}</section><section><h2>待辦</h2><ul>${Array.from({ length: 8 }, (_, i) => `<li>待辦 ${i + 1}：${['遞狀', '閱卷', '聯繫當事人', '繳費'][i % 4]}（期限 10/${20 + i}）</li>`).join('')}</ul></section><section><h2>近期活動</h2><table border="1">${Array.from({ length: 6 }, (_, i) => `<tr><td>事件 ${i + 1}</td><td>${['開庭', '收文', '結案', '付款'][i % 4]}</td><td>10/${10 + i}</td></tr>`).join('')}</table></section>`),
  p9: page('技術文件', `<div><nav><h2>API 文件</h2>${['快速開始', '認證', '端點', '錯誤碼', '速率限制'].map((s, i) => `<a href="#d${i}">${s}</a>`).join('')}</nav><main><h1>ego-linux API</h1><h2 id="d0">快速開始</h2><p>安裝後執行 ego-browserd，接著以 nodejs 子命令驅動。</p><pre><code>const task = await taskSpace("demo");\nconst page = task.page("p1");\nawait page.goto("https://example.com");</code></pre><h2 id="d1">認證</h2><p>daemon 以 127.0.0.1 綁定並要求 token 標頭。</p><h2 id="d2">端點</h2><p>POST /rpc；GET /events（SSE）。</p></main></div>`),
  p10: page('畫布應用', `<canvas id="c" width="1400" height="860"></canvas><script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,1400,860);for(let i=0;i&lt;40;i++){c.fillStyle=\`hsl(\${i*9},70%,60%)\`;c.beginPath();c.arc(80+(i%8)*160,120+Math.floor(i/8)*180,50,0,7);c.fill();c.fillStyle='#000';c.fillText('節點'+(i+1),60+(i%8)*160,125+Math.floor(i/8)*180);}</script>`),
};

createServer((req, res) => {
  if (req.url.startsWith('/download')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="bench.txt"' });
    res.end('bench payload\n');
    return;
  }
  const key = req.url.slice(1).split('?')[0];
  const html = PAGES[key];
  if (!html) { res.writeHead(404).end('no such page'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8890, '127.0.0.1', () => console.log('bench pages: http://127.0.0.1:8890/p1 … p10'));
