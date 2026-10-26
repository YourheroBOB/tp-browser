// Domains cleared by resetSiteAuth. Suffix-only: hostname equals the suffix
// or ends with '.' + suffix. Never unanchored substring, never last-two-labels.

const MICROSOFT_SUFFIXES = [
  'microsoftonline.com',
  'live.com',
  'microsoft.com',
  'office.com',
  'azure.com',
  'hotmail.com',
];

const GOOGLE_SUFFIXES = [
  'google.com',
  'accounts.google.com',
  'youtube.com',
  'gmail.com',
];

export function hostMatchesSuffix(host, suffix) {
  const h = String(host || '').toLowerCase();
  const s = String(suffix || '').toLowerCase();
  if (!h || !s) return false;
  return h === s || h.endsWith('.' + s);
}

function familyFor(host) {
  const h = String(host || '').toLowerCase();
  if (MICROSOFT_SUFFIXES.some((s) => hostMatchesSuffix(h, s))) return MICROSOFT_SUFFIXES;
  if (GOOGLE_SUFFIXES.some((s) => hostMatchesSuffix(h, s))) return GOOGLE_SUFFIXES;
  return [];
}

export function collectResetDomains(host) {
  const match = new Set();
  const h = String(host || '').toLowerCase();
  if (!h) return match;
  match.add(h);
  for (const s of familyFor(h)) match.add(s);
  return match;
}

export function cookieDomainMatches(cookieDomain, matchDomains) {
  const cd = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  for (const md of matchDomains) {
    if (cd === md || cd.endsWith('.' + md)) return true;
  }
  return false;
}
