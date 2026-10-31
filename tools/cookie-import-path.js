// Resolve cookie import sources. No /tmp fallback. Keep in sync with cookies-import.ego.js.
import { join } from 'node:path';

export function resolveCookieImportPath({ env = {}, home, exists } = {}) {
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const envPath = env.TP_COOKIES_FILE || env.EGO_COOKIES_FILE || '';
  const c1 = join(dataDir, 'cookies.json');
  const c2 = join(dataDir, 'ego-cookies.json');
  const candidates = [
    { label: 'TP_COOKIES_FILE/EGO_COOKIES_FILE', path: envPath || '(unset)', exists: Boolean(envPath) && exists(envPath) },
    { label: c1, path: c1, exists: exists(c1) },
    { label: c2, path: c2, exists: exists(c2) },
  ];
  if (envPath && exists(envPath)) return { ok: true, path: envPath, candidates };
  if (exists(c1)) return { ok: true, path: c1, candidates };
  if (exists(c2)) return { ok: true, path: c2, candidates };
  return { ok: false, path: null, candidates };
}
