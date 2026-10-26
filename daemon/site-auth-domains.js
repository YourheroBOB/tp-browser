// Domains cleared by resetSiteAuth.
// Host plus parents down to the registrable domain (public-suffix + 1 label),
// plus a label-boundary family list for Microsoft / Google SSO cookies.

const MULTI_PART_SUFFIXES = new Set([
  'com.tw', 'com.au', 'com.br', 'com.hk', 'com.sg', 'com.mx', 'com.ar',
  'com.cn', 'com.tr', 'com.vn', 'com.my', 'com.ph', 'com.co', 'com.ng',
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.id', 'co.th', 'co.il',
  'ne.jp', 'or.jp', 'ac.uk', 'gov.uk',
  'gov.tw', 'org.tw', 'edu.tw', 'net.tw', 'idv.tw',
  'azurewebsites.net', 'cloudapp.net', 'windows.net',
  'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app',
]);

const MICROSOFT_CLEAR = [
  'microsoftonline.com',
  'microsoftonline.us',
  'live.com',
  'microsoft.com',
  'office.com',
  'office.net',
  'office365.com',
  'outlook.com',
  'sharepoint.com',
  'azure.com',
  'azure.net',
  'hotmail.com',
  'msn.com',
];

const MICROSOFT_TRIGGERS = [
  ...MICROSOFT_CLEAR,
  'azurewebsites.net',
  'cloudapp.net',
  'windows.net',
];

const GOOGLE_FAMILY = [
  'google.com',
  'googleapis.com',
  'googleusercontent.com',
  'gstatic.com',
  'gmail.com',
  'youtube.com',
  'youtu.be',
  'ggpht.com',
  'android.com',
];

const GOOGLE_LABELS = new Set([
  'google', 'youtube', 'gmail', 'googleusercontent', 'ggpht', 'googleapis', 'gstatic',
]);

export function hostMatchesSuffix(host, suffix) {
  const h = String(host || '').toLowerCase();
  const s = String(suffix || '').toLowerCase();
  if (!h || !s) return false;
  return h === s || h.endsWith('.' + s);
}

export function publicSuffix(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return '';
  const labels = h.split('.');
  if (labels.length >= 3) {
    const three = labels.slice(-3).join('.');
    if (MULTI_PART_SUFFIXES.has(three)) return three;
  }
  if (labels.length >= 2) {
    const two = labels.slice(-2).join('.');
    if (MULTI_PART_SUFFIXES.has(two)) return two;
  }
  return labels[labels.length - 1] || '';
}

export function registrableDomain(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return '';
  const sfx = publicSuffix(h);
  const sfxLen = sfx.split('.').filter(Boolean).length;
  const labels = h.split('.');
  if (labels.length <= sfxLen) return h;
  return labels.slice(-(sfxLen + 1)).join('.');
}

export function parentDomainsToRegistrable(host) {
  const h = String(host || '').toLowerCase();
  const reg = registrableDomain(h);
  const out = [];
  if (!h) return out;
  let cur = h;
  for (;;) {
    out.push(cur);
    if (cur === reg) break;
    const dot = cur.indexOf('.');
    if (dot < 0) break;
    cur = cur.slice(dot + 1);
    if (cur.length < reg.length) break;
  }
  return out;
}

function familyFor(host) {
  const h = String(host || '').toLowerCase();
  if (MICROSOFT_TRIGGERS.some((s) => hostMatchesSuffix(h, s))) return MICROSOFT_CLEAR;
  const labels = h.split('.');
  if (labels.some((l) => GOOGLE_LABELS.has(l))) return GOOGLE_FAMILY;
  if (GOOGLE_FAMILY.some((s) => hostMatchesSuffix(h, s))) return GOOGLE_FAMILY;
  return [];
}

export function collectResetDomains(host) {
  const match = new Set();
  const h = String(host || '').toLowerCase();
  if (!h) return match;
  for (const d of parentDomainsToRegistrable(h)) match.add(d);
  for (const s of familyFor(h)) match.add(s);
  return match;
}

export function cookieDomainMatches(cookieDomain, matchDomains) {
  const cd = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  if (!cd) return false;
  for (const md of matchDomains) {
    if (cd === md || cd.endsWith('.' + md)) return true;
  }
  return false;
}
