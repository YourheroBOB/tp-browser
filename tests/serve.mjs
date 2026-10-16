// Tiny static server for the smoke test page: http://127.0.0.1:8899/
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'testpage.html'), 'utf8');

const chatHtml = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Sakana AI Chat Mock</title></head>
<body>
  <header>
    <button aria-label="Select model and response style" type="button">Fugu (Standard)</button>
  </header>
  <main id="chat-box"></main>
  <footer>
    <input type="file" id="fupload" />
    <textarea id="chat-ta" rows="4" cols="60" placeholder="Ask anything..."></textarea>
  </footer>
  <script>
    const ta = document.getElementById('chat-ta');
    const fu = document.getElementById('fupload');
    const box = document.getElementById('chat-box');
    async function submitChat() {
      const q = ta.value.trim();
      if (!q) return;
      let fname = 'none', fbytes = 0, fchars = 0, fhead = '';
      if (fu.files && fu.files.length > 0) {
        const f = fu.files[0];
        fname = f.name;
        fbytes = f.size;
        const txt = await f.text();
        fchars = txt.length;
        fhead = txt.slice(0, 60).replace(/\\s+/g, ' ');
      }
      const art = document.createElement('article');
      art.innerHTML = \`<div class="resp">Generated a response
【TooPowerChat 附件外包推理完成】
- 接收附件：\${fname}（\${fbytes} bytes / \${fchars} chars）
- 附件首段：\${fhead}...
- 提問內容：\${q}
- 推理結論：
  1. 透過 TP 瀏覽器 (ego-linux) DOM.setFileInputFiles 直接將長文由本機磁碟注入瀏覽器，完全不經過主對話 LLM Context。
  2. 語意快照 (snapshot) 與確定性動作回執 (receipt) 取代傳統 Computer-Use 逐步截圖，大幅降低 Token 消耗。
  3. 任務空間完成後自動執行 completeTaskSpace 釋放分頁，零殘留。
Copy</div><button aria-label="Copy" type="button">Copy</button>\`;
      box.appendChild(art);
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitChat();
      }
    });
  </script>
</body>
</html>`;

createServer((req, res) => {
  if (req.url.startsWith('/download')) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="smoke.txt"',
    });
    res.end('ego-linux download smoke payload\n');
    return;
  }
  if (req.url.startsWith('/chat.sakana.ai')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(chatHtml);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8899, '127.0.0.1', () => console.log('smoke page: http://127.0.0.1:8899/'));
