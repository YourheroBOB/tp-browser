// Tab title updates. Page.documentTitleChanged is not a CDP event;
// Chromium reports title via Target.targetInfoChanged and document.title
// after load / DOMContentLoaded.

export function applyTargetInfoChanged(sessions, params) {
  const ti = params?.targetInfo;
  if (!ti || !ti.targetId || !sessions) return false;
  const st = sessions.get(ti.targetId);
  if (!st) return false;
  if (typeof ti.title === 'string') st.title = ti.title;
  if (typeof ti.url === 'string' && ti.url) st.url = ti.url;
  return true;
}

export function wantsDocumentTitleRefresh(method, params) {
  if (method === 'Page.loadEventFired' || method === 'Page.domContentEventFired') return true;
  if (method === 'Page.frameNavigated' && params?.frame && !params.frame.parentId) return true;
  return false;
}
