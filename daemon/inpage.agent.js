// Browser-side agent module. Injected once per document by the daemon via
// Runtime.evaluate. Loaded as TEXT by the daemon (never imported by Node).
// Provides: stable refs (WeakMap), selector engine, ego-format snapshot tree,
// element descriptors/handles, value editing helpers.
(() => {
  if (window.__egoAgent) return 'reuse';
  const handles = new Map(); // hid -> element
  let hseq = 0;
  const refMap = new WeakMap(); // element -> ref number
  const refIndex = new Map(); // ref -> element
  let rseq = 0;

  const refOf = (el) => {
    let r = refMap.get(el);
    if (!r) { r = ++rseq; refMap.set(el, r); refIndex.set(r, el); }
    return r;
  };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS']);

  function roleOf(el) {
    const tag = el.tagName;
    if (!tag) return null;
    if (el.getAttribute) {
      const role = el.getAttribute('role');
      if (role) return role.split(/\s+/)[0];
    }
    switch (tag) {
      case 'HTML': return 'root';
      case 'BODY': return null;
      case 'A': return 'anchor';
      case 'BUTTON': return 'button';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'P': return 'paragraph';
      case 'UL': case 'OL': return 'list';
      case 'LI': return 'listitem';
      case 'IMG': return 'img';
      case 'SVG': return 'svg_root';
      case 'TEXTAREA': return 'textbox';
      case 'SELECT': return 'combobox';
      case 'TABLE': return 'table';
      case 'TR': return 'row';
      case 'NAV': return 'navigation';
      case 'LABEL': return 'label';
      case 'FORM': return 'form';
      default:
        if (tag === 'INPUT') {
          const t = (el.type || 'text').toLowerCase();
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
          if (t === 'search') return 'searchbox';
          return 'textbox';
        }
        return null;
    }
  }

  function visibleInViewport(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  function accessName(el) {
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return norm(al);
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((e) => norm(e.textContent));
      if (parts.length) return parts.join(' ');
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return norm(lab.textContent);
    }
    const t = norm(el.textContent);
    if (t) return t;
    if ('value' in el && el.value) return String(el.value);
    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;
    if (el.alt) return el.alt;
    return '';
  }

  function parseSelector(sel) {
    // returns {kind, ...}
    let m;
    if ((m = sel.match(/^@(\d+)$/)) || (m = sel.match(/^ref=(\d+)$/))) return { kind: 'ref', ref: +m[1] };
    if (sel.startsWith('text=')) {
      const t = sel.slice(5);
      if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) return { kind: 'text', value: t.slice(1, -1), exact: true };
      return { kind: 'text', value: t, exact: false };
    }
    if (sel.startsWith('loc=role:')) {
      const rest = sel.slice(9);
      const mm = rest.match(/^([A-Za-z]+)(?:\[(.+)\])?$/);
      if (!mm) return { kind: 'invalid' };
      return { kind: 'role', role: mm[1].toLowerCase(), nameSpec: mm[2] || null };
    }
    if (sel.startsWith('loc=css:')) return { kind: 'css', value: sel.slice(8) };
    if (sel.startsWith('css:')) return { kind: 'css', value: sel.slice(4) };
    if (sel.startsWith('loc=href:')) return { kind: 'href', value: sel.slice(9) };
    if (sel.startsWith('xpath=')) return { kind: 'xpath', value: sel.slice(6) };
    // css=... with optional :has-text()/:text-is() and >> nth=N
    if (sel.startsWith('css=')) {
      let body = sel.slice(4); let nth = null;
      const ni = body.lastIndexOf('>> nth=');
      if (ni !== -1) { nth = parseInt(body.slice(ni + 7), 10); body = body.slice(0, ni).trim(); }
      const hi = body.search(/:has-text\(|:text-is\(/);
      if (hi !== -1) {
        const cssPart = body.slice(0, hi);
        const mm = body.slice(hi).match(/^:(has-text|text-is)\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)$/);
        if (!mm) return { kind: 'invalid' };
        return { kind: 'cssText', css: cssPart, mode: mm[1], text: mm[2].slice(1, -1), nth };
      }
      return { kind: 'css', value: body, nth };
    }
    // text=... >> nth=N
    if ((m = sel.match(/^text=(?:"((?:[^"\\]|\\.)*)"|([^">]+))\s*>>\s*nth=(-?\d+)$/))) {
      return { kind: 'text', value: m[1] !== undefined ? m[1] : m[2].trim(), exact: m[1] !== undefined, nth: parseInt(m[3], 10) };
    }
    if (sel.startsWith('text=') && sel.includes('>> nth=')) {
      const [a, b] = sel.split('>>');
      return { kind: 'text', value: a.slice(5).trim(), exact: false, nth: parseInt(b.replace('nth=', '').trim(), 10) };
    }
    return { kind: 'css', value: sel, nth: null };
  }

  function roleQuery(spec) {
    const out = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (roleOf(el) !== spec.role) continue;
      if (!visibleInViewport(el) && !spec.forceAll) continue;
      if (spec.nameSpec) {
        const mm = spec.nameSpec.match(/^name(\*)?=("(.*)"|'(.*)')$/);
        if (mm) {
          const want = mm[3] !== undefined ? mm[3] : mm[4];
          const contains = !!mm[1];
          const name = accessName(el);
          if (contains ? !name.toLowerCase().includes(want.toLowerCase()) : name !== want) continue;
        } else { continue; }
      }
      out.push(el);
    }
    return out;
  }

  function select(sel) {
    const spec = parseSelector(sel);
    let els = [];
    switch (spec.kind) {
      case 'ref': { const el = refIndex.get(spec.ref); els = el ? [el] : []; break; }
      case 'text': {
        const want = spec.exact ? spec.value : norm(spec.value).toLowerCase();
        const all = document.querySelectorAll('a, button, input, select, textarea, [role], h1,h2,h3,h4,h5,h6, p, li, td, th, label, span, div');
        for (const el of all) {
          if (!visibleInViewport(el)) continue;
          const own = norm(el.childNodes ? Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : '');
          const t = spec.exact ? own : own.toLowerCase();
          if (spec.exact ? t === want : t.includes(want)) els.push(el);
        }
        break;
      }
      case 'role': els = roleQuery(spec); break;
      case 'css': {
        let list = [];
        try { list = Array.from(document.querySelectorAll(spec.value)); } catch { return { els: [], spec, error: 'invalid selector' }; }
        els = list.filter(visibleInViewport);
        if (els.length === 0 && list.length > 0) els = list; // force path handles hidden
        if (spec.nth !== null && spec.nth !== undefined) { els = els.slice(spec.nth, spec.nth + 1); }
        break;
      }
      case 'cssText': {
        let list = [];
        try { list = Array.from(document.querySelectorAll(spec.css || '*')); } catch { return { els: [], spec, error: 'invalid selector' }; }
        const want = norm(spec.text);
        els = list.filter((el) => {
          if (!visibleInViewport(el)) return false;
          const t = spec.mode === 'text-is' ? norm(el.textContent) : norm(el.textContent).toLowerCase();
          return spec.mode === 'text-is' ? t === want : t.includes(want.toLowerCase());
        });
        if (spec.nth !== null && spec.nth !== undefined) els = els.slice(spec.nth, spec.nth + 1);
        break;
      }
      case 'href': {
        els = Array.from(document.querySelectorAll('a[href]')).filter((el) => {
          const h = el.getAttribute('href') || '';
          return (el.href || '').includes(spec.value) || h.includes(spec.value);
        });
        break;
      }
      case 'xpath': {
        const xr = document.evaluate(spec.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < xr.snapshotLength; i++) els.push(xr.snapshotItem(i));
        break;
      }
      default: return { els: [], spec, error: 'invalid selector' };
    }
    return { els, spec };
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      ref: refOf(el),
      role: roleOf(el),
      tag: el.tagName ? el.tagName.toLowerCase() : null,
      text: trunc(norm(el.textContent), 160),
      name: accessName(el),
      href: el.href || null,
      x: r.left, y: r.top, w: r.width, h: r.height,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      disabled: !!el.disabled,
      visible: visibleInViewport(el),
    };
  }

  function ensureVisible(hid) {
    const el = elOf(hid);
    if (!el) return { cx: 0, cy: 0, x: 0, y: 0, w: 0, h: 0 };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function resolve(sel, { timeoutMs = 0, requireVisible = true } = {}) {
    const res = select(sel);
    let els = res.els;
    if (requireVisible) els = els.filter((el) => visibleInViewport(el) || INTERACTIVE.has(el.tagName));
    const count = els.length;
    if (count !== 1) return { count, error: res.error || null, hid: null };
    const el = els[0];
    let hid = null;
    for (const [k, v] of handles) if (v === el) { hid = k; break; }
    if (hid === null) { hid = ++hseq; handles.set(hid, el); }
    return { count, hid, d: describe(el), error: null };
  }

  const elOf = (hid) => handles.get(hid) || null;

  // ---- snapshot tree (ego format) ----
  function snap({ scope = 'only_within_viewport', rootRef = null } = {}) {
    const lines = [];
    let budget = 4000;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    const inScope = (el) => {
      if (scope === 'full_page' || scope === 'subtree') return true;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    };

    const emitText = (t, depth) => {
      const s = norm(t);
      if (!s) return;
      lines.push('  '.repeat(depth) + 'text ' + JSON.stringify(trunc(s, 140)));
    };

    const walk = (node, depth) => {
      if (budget-- <= 0) return;
      if (node.nodeType === 3) { emitText(node.textContent, depth); return; }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName;
      if (!tag) return;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'HEAD' || tag === 'LINK' || tag === 'META') return;
      const role = roleOf(el);
      const interactive = role && role !== 'root' && role !== 'paragraph' && role !== 'heading' && role !== 'text' &&
        (INTERACTIVE.has(tag) || ['anchor', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox', 'listitem', 'label'].includes(role) || el.hasAttribute('role'));
      const show = (role === 'root') || interactive || ['heading', 'paragraph', 'img', 'svg_root', 'list', 'listitem', 'navigation', 'table', 'row'].includes(role);
      if (!show) {
        // container or unknown: recurse into children; render own text nodes
        let d = depth;
        for (const c of el.childNodes) {
          if (c.nodeType === 3) emitText(c.textContent, d);
          else walk(c, d);
        }
        return;
      }
      if (!inScope(el) && !(role === 'root')) return;
      let line = '  '.repeat(depth) + role;
      if (role !== 'root') {
        const ref = refOf(el);
        const parts = ['ref=' + ref];
        if (role === 'anchor' && el.href) { parts.push('loc=href:' + el.href); parts.push('url=' + el.href); }
        if (tag === 'INPUT' && el.value) parts.push('value=' + JSON.stringify(trunc(String(el.value), 60)));
        line += ' [' + parts.join(', ') + ']';
      }
      lines.push(line);
      const childDepth = depth + 1;
      if (role === 'img') { const al = norm(el.alt); if (al) lines.push('  '.repeat(childDepth) + 'text ' + JSON.stringify(trunc(al, 140))); return; }
      for (const c of el.childNodes) walk(c, childDepth);
    };

    let startNode = document.documentElement;
    if (scope === 'subtree') {
      const rootEl = rootRef !== null ? refIndex.get(+rootRef) : null;
      if (!rootEl) return { lines: ['(invalid subtree root ref)'], title: document.title, url: location.href };
      lines.push('  '.repeat(0) + (roleOf(rootEl) || rootEl.tagName.toLowerCase()) + ' [ref=' + refOf(rootEl) + ']');
      for (const c of rootEl.childNodes) walk(c, 1);
    } else {
      walk(startNode, 0);
    }
    return {
      lines,
      title: document.title,
      url: location.href,
      vw, vh,
      sx: window.scrollX, sy: window.scrollY,
      pw: document.documentElement.scrollWidth, ph: document.documentElement.scrollHeight,
    };
  }

  function fillValue(hid, value) {
    const el = elOf(hid);
    if (!el) return { ok: false, error: 'stale handle' };
    let target = el;
    if (target.tagName === 'LABEL' && target.control) target = target.control;
    el.focus && el.focus();
    if (target.isContentEditable) {
      target.textContent = '';
      return { ok: true, editable: true };
    }
    if (target.select) { try { target.select(); } catch {} }
    try { target.value = ''; } catch {}
    return { ok: true, editable: false };
  }

  function checkValue(hid, value) {
    const el = elOf(hid);
    if (!el) return false;
    let t = el;
    if (t.tagName === 'LABEL' && t.control) t = t.control;
    if (t.isContentEditable) return norm(t.textContent) === norm(value);
    return String(t.value ?? '') === String(value);
  }

  function selectOptions(hid, picks) {
    const el = elOf(hid);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'not a select' };
    const opts = Array.from(el.options);
    const chosen = [];
    for (const pick of picks) {
      let o = null;
      if (typeof pick === 'number') o = opts[pick];
      else if (pick && typeof pick === 'object') {
        o = opts.find((x) => (pick.value !== undefined && x.value === pick.value) || (pick.label !== undefined && norm(x.textContent) === norm(pick.label))) || null;
      } else {
        o = opts.find((x) => x.value === pick) || opts.find((x) => norm(x.textContent) === norm(pick)) || null;
      }
      if (o) chosen.push(o);
    }
    if (!el.multiple) { el.value = chosen.length ? chosen[0].value : ''; }
    else { for (const o of opts) o.selected = chosen.includes(o); }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: chosen.map((o) => o.value) };
  }

  function focusEl(hid) {
    const el = elOf(hid);
    if (!el) return { ok: false };
    let t = el;
    if (t.tagName === 'LABEL' && t.control) t = t.control;
    try { t.focus({ preventScroll: false }); } catch { return { ok: false }; }
    return { ok: document.activeElement === t || document.activeElement === el };
  }

  function markForDom(hid, mark) {
    // Daemon supplies ego-<digits>; this script only sets the attribute.
    const el = elOf(hid);
    if (!el || typeof mark !== 'string') return null;
    el.setAttribute('data-ego-dom', mark);
    return mark;
  }

  function fileInfo(hid) {
    const el = elOf(hid);
    if (!el) return null;
    let t = el;
    if (t.tagName === 'LABEL' && t.control) t = t.control;
    const input = t.tagName === 'INPUT' && t.type === 'file' ? t : (t.querySelector ? t.querySelector('input[type=file]') : null);
    if (!input) return null;
    return { multiple: !!input.multiple, accept: input.accept || '' };
  }

  window.__egoAgent = { resolve, describe, ensureVisible, snap, fillValue, checkValue, selectOptions, focusEl, markForDom, fileInfo, refOf, accessName, visibleInViewport };
  return 'installed';
})()
