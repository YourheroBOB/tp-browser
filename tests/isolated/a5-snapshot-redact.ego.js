const FX = 'http://127.0.0.1:' + ((typeof process !== 'undefined' && process.env.TP_FIXTURE_PORT) || 8899) + '/';
// RG-A5: snapshot must not leak password / card / OTP / hidden input values.
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} A5 ${n}${x ? ' — ' + x : ''}`); if (!c) process.exitCode = 1; };
const t = await taskSpace('rg-a5');
const p = t.page('p1');
await p.goto(FX, { waitUntil: 'load' });
await p.evaluate(() => {
  const f = document.createElement('form');
  f.innerHTML = '<input id="u" type="text" value="visible-user">' +
    '<input id="pw" type="password" value="fixture-secret-pw">' +
    '<input id="cc" type="text" autocomplete="cc-number" value="4111111111111111">' +
    '<input id="otp" type="text" autocomplete="one-time-code" value="842913">' +
    '<input id="h" type="hidden" value="fixture-hidden-csrf">';
  document.body.appendChild(f);
});
const snap = await p.snapshot();
ok('password not in snapshot', !snap.includes('fixture-secret-pw'));
ok('card number not in snapshot', !snap.includes('4111111111111111'));
ok('otp not in snapshot', !snap.includes('842913'));
ok('hidden not in snapshot', !snap.includes('fixture-hidden-csrf'));
ok('redaction marker present', snap.includes('value=[redacted]'));
ok('plain text value still visible', snap.includes('visible-user'));
await t.finish();
