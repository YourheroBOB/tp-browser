// Usage: node --experimental-websocket cdp-cookie.mjs <chromePort> <cookieName>  -> prints session|persistent|missing
const [port, name] = process.argv.slice(2);
const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }));
const msg = await new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }; });
const c = (msg.result?.cookies || []).find((x) => x.name === name);
console.log(!c ? 'missing' : (c.session ? 'session' : 'persistent'));
ws.close();
