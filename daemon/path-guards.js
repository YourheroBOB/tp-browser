// Loopback CDP WebSocket URL, download-dir names, and leaf-symlink write guards.
// Keep this module free of page-ops / daemon imports so unit tests can load it
// without listening on a port.
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const COPY_CHUNK = 64 * 1024;

export class PathGuardError extends Error {
  constructor(message, name = 'BadPath') {
    super(message);
    this.name = name;
  }
}

export function hasDotDotSegment(p) {
  return String(p || '').replace(/\\/g, '/').split('/').some((part) => part === '..');
}

export function validateLoopbackDebuggerWsUrl(wsUrl, expectedPort) {
  if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
    throw new Error('unexpected webSocketDebuggerUrl');
  }
  let u;
  try {
    u = new URL(wsUrl);
  } catch {
    throw new Error('unexpected webSocketDebuggerUrl');
  }
  if (u.protocol !== 'ws:') throw new Error('unexpected webSocketDebuggerUrl');
  if (u.username || u.password) throw new Error('unexpected webSocketDebuggerUrl');
  if (u.hostname !== '127.0.0.1') throw new Error('unexpected webSocketDebuggerUrl');
  const port = u.port || '80';
  if (String(port) !== String(expectedPort)) throw new Error('unexpected webSocketDebuggerUrl');
  return wsUrl;
}

export function safeDownloadEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error('invalid download name');
  }
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new Error('invalid download name');
  }
  const unified = String(name).replace(/\\/g, '/');
  if (hasDotDotSegment(unified) || unified.includes('/')) {
    throw new Error('invalid download name');
  }
  const base = path.basename(unified);
  if (!base || base === '.' || base === '..') {
    throw new Error('invalid download name');
  }
  if (/[\\/]/.test(base)) throw new Error('invalid download name');
  return base;
}

export function downloadPathInDir(downloadsDir, name) {
  const base = safeDownloadEntryName(name);
  const root = path.resolve(downloadsDir);
  const full = path.join(root, base);
  const resolved = path.resolve(full);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('invalid download path');
  }
  return resolved;
}

export function assertSafePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new PathGuardError('invalid path');
  }
  if (hasDotDotSegment(p)) throw new PathGuardError(`path traversal rejected: ${p}`);
  if (!path.isAbsolute(p)) throw new PathGuardError(`absolute path required, got: ${p}`);
  const norm = path.resolve(p);
  const parts = norm.split(path.sep);
  if (parts.includes('..') || parts.includes('.')) {
    throw new PathGuardError(`path traversal rejected: ${p}`);
  }
  return norm;
}

export function safePath(p, { mustExist = false } = {}) {
  const norm = assertSafePath(p);
  if (mustExist) {
    try {
      return assertSafePath(realpathSync.native(norm));
    } catch (e) {
      if (e && e.name === 'BadPath') throw e;
      throw new PathGuardError(`path does not exist: ${p}`);
    }
  }
  const dir = path.dirname(norm);
  try {
    if (lstatSync(dir)) assertSafePath(realpathSync.native(dir));
  } catch (e) {
    if (e && e.name === 'BadPath') throw e;
    if (e?.code !== 'ENOENT') {
      // Parent may be a symlink (macOS /tmp → /private/tmp); realpath handles that
      // when the directory exists. Missing parent is allowed; mkdir happens later.
    }
  }
  try {
    const st = lstatSync(norm);
    if (st.isSymbolicLink()) {
      throw new PathGuardError('refusing to write through leaf symlink');
    }
  } catch (e) {
    if (e && e.name === 'BadPath') throw e;
    if (e?.code !== 'ENOENT') throw e;
  }
  return norm;
}

function writeAllSync(fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (!n) throw new Error('short write');
    off += n;
  }
}

function openDestNoFollow(target, mode) {
  let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;
  if (typeof fsConstants.O_NOFOLLOW === 'number') flags |= fsConstants.O_NOFOLLOW;
  try {
    return openSync(target, flags, mode);
  } catch (e) {
    if (e?.code === 'ELOOP' || e?.code === 'EMLINK') {
      throw new PathGuardError('refusing to write through leaf symlink');
    }
    throw e;
  }
}

function destExistedNotSymlink(target) {
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      throw new PathGuardError('refusing to write through leaf symlink');
    }
    return true;
  } catch (e) {
    if (e && e.name === 'BadPath') throw e;
    if (e?.code !== 'ENOENT') throw e;
    return false;
  }
}

export function writeFileNoFollow(filePath, data, { mode = 0o600 } = {}) {
  const target = safePath(filePath);
  const existed = destExistedNotSymlink(target);
  const fd = openDestNoFollow(target, mode);
  try {
    writeAllSync(fd, data);
  } finally {
    closeSync(fd);
  }
  if (!existed) {
    try { chmodSync(target, mode); } catch {}
  }
  return target;
}

export function copyFileNoFollow(src, dest, { mode = 0o600 } = {}) {
  const target = safePath(dest);
  const existed = destExistedNotSymlink(target);
  let srcFd;
  try {
    srcFd = openSync(src, fsConstants.O_RDONLY);
  } catch (e) {
    throw e;
  }
  let destFd;
  try {
    destFd = openDestNoFollow(target, mode);
  } catch (e) {
    try { closeSync(srcFd); } catch {}
    throw e;
  }
  try {
    const buf = Buffer.alloc(COPY_CHUNK);
    let n;
    while ((n = readSync(srcFd, buf, 0, buf.length, null)) > 0) {
      writeAllSync(destFd, buf.subarray(0, n));
    }
  } finally {
    try { closeSync(srcFd); } catch {}
    try { closeSync(destFd); } catch {}
  }
  if (!existed) {
    try { chmodSync(target, mode); } catch {}
  }
  return target;
}

export const DOM_MARK_RE = /^ego-[0-9a-f]{32}$/;

export function nextDomMark() {
  return `ego-${randomBytes(16).toString('hex')}`;
}

export function acceptDomMark(returned, expected) {
  return typeof returned === 'string'
    && typeof expected === 'string'
    && returned === expected
    && DOM_MARK_RE.test(expected);
}
