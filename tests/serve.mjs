// Tiny static server for the smoke test page: http://127.0.0.1:8899/
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'testpage.html'), 'utf8');

createServer((req, res) => {
  if (req.url.startsWith('/download')) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="smoke.txt"',
    });
    res.end('ego-linux download smoke payload\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8899, '127.0.0.1', () => console.log('smoke page: http://127.0.0.1:8899/'));
