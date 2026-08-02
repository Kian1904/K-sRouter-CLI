/**
 * K-Router CLI Host — File Reader & Session Manager
 * Location: /lib/host.js
 *
 * Memberi CLI & ReAct Loop kemampuan membaca, melacak, dan mengelola file lokal.
 * Dilengkapi getFileContent, setFileContent, dan resolvePath untuk integrasi penuh.
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { createHash } from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES    = 500 * 1024;
const MAX_CONTEXT_BYTES = 200 * 1024;
const SESSION_PATH      = path.join(os.homedir(), '.krouter_session.json');
const DEFAULT_PATH      = path.join(os.homedir(), 'storage', 'shared', 'Download');

const ALLOWED_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.html', '.css', '.scss', '.vue', '.svelte',
  '.json', '.yaml', '.yml',
  '.md', '.txt', '.env',
  '.config', '.sh', '.py', '.sql'
]);

// ─── Session State ────────────────────────────────────────────────────────────

let _session = {
  activePath:  null,
  loadedFiles: {},   // { filename: { content, fingerprint, size, fullPath, loadedAt } }
  history:     []
};

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _fingerprint(content) {
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}

function _fmtBytes(bytes) {
  if (bytes < 1024)        return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function _isAllowed(filename) {
  return ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function _resolvePath(inputPath) {
  if (!inputPath || inputPath === '.') return _session.activePath || DEFAULT_PATH;
  if (inputPath.startsWith('~'))       return inputPath.replace('~', os.homedir());
  if (path.isAbsolute(inputPath))      return inputPath;
  if (_session.activePath)             return path.join(_session.activePath, inputPath);
  return path.resolve(inputPath);
}

function _contextBytes() {
  let total = 0;
  for (const key in _session.loadedFiles) {
    total += _session.loadedFiles[key].size || 0;
  }
  return total;
}

function _saveSession() {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(_session, null, 2), 'utf8');
  } catch (e) {}
}

function _loadSession() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return;
    const raw = fs.readFileSync(SESSION_PATH, 'utf8');
    _session = JSON.parse(raw);
  } catch (e) {
    _session = { activePath: null, loadedFiles: {}, history: [] };
  }
}

function _readEntries(dirPath) {
  const raw     = fs.readdirSync(dirPath, { withFileTypes: true });
  const entries = [];
  for (const e of raw) {
    if (e.isDirectory()) {
      entries.push({ name: e.name, type: 'dir', size: null, readable: false });
    } else if (e.isFile()) {
      const size     = fs.statSync(path.join(dirPath, e.name)).size;
      const readable = _isAllowed(e.name) && size <= MAX_FILE_BYTES;
      entries.push({ name: e.name, type: 'file', size: _fmtBytes(size), readable: readable });
    }
  }
  return entries;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve relative/absolute path berdasarkan active workspace
 */
export function resolvePath(inputPath) {
  return _resolvePath(inputPath);
}

/**
 * Membuka folder kerja baru & mereset context file
 */
export function openPath(inputPath) {
  const target = _resolvePath(inputPath) || DEFAULT_PATH;

  if (!fs.existsSync(target)) {
    return { ok: false, error: 'Path tidak ditemukan: ' + target };
  }
  if (!fs.statSync(target).isDirectory()) {
    return { ok: false, error: 'Bukan folder: ' + target };
  }

  let entries;
  try {
    entries = _readEntries(target);
  } catch (e) {
    return { ok: false, error: 'Gagal baca folder: ' + e.message };
  }

  _session.activePath  = target;
  _session.loadedFiles = {};
  _session.history.push({ ts: new Date().toISOString(), action: 'open', detail: target });
  if (_session.history.length > 50) _session.history.shift();
  _saveSession();

  return { ok: true, activePath: target, entries: entries };
}

/**
 * Menampilkan daftar isi folder saat ini
 */
export function listCurrent(inputPath) {
  const target = inputPath ? _resolvePath(inputPath) : (_session.activePath || DEFAULT_PATH);

  if (!fs.existsSync(target)) {
    return { ok: false, error: 'Path tidak ditemukan: ' + target };
  }

  let entries;
  try {
    entries = _readEntries(target);
  } catch (e) {
    return { ok: false, error: 'Gagal baca folder: ' + e.message };
  }

  return { ok: true, activePath: target, entries: entries };
}

/**
 * Membaca file dari disk dan memuatnya ke context cache session
 */
export function readFile(filename) {
  if (!filename) {
    return { ok: false, error: 'Nama file diperlukan' };
  }

  const target = _resolvePath(filename);

  if (!fs.existsSync(target)) {
    return { ok: false, error: 'File tidak ditemukan: ' + target };
  }

  const stat = fs.statSync(target);

  if (!stat.isFile()) {
    return { ok: false, error: 'Bukan file: ' + target };
  }

  if (!_isAllowed(target)) {
    return { ok: false, error: 'Tipe file tidak didukung: ' + path.extname(target) };
  }

  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, error: 'File terlalu besar: ' + _fmtBytes(stat.size) + ' (max ' + _fmtBytes(MAX_FILE_BYTES) + ')' };
  }

  let content;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (e) {
    return { ok: false, error: 'Gagal baca file: ' + e.message };
  }

  const fp       = _fingerprint(content);
  const basename = path.basename(target);
  const existing = _session.loadedFiles[basename];
  const changed  = existing && existing.fingerprint !== fp;

  _session.loadedFiles[basename] = {
    content:     content,
    fingerprint: fp,
    size:        stat.size,
    fullPath:    target,
    loadedAt:    new Date().toISOString()
  };

  _session.history.push({ ts: new Date().toISOString(), action: 'read', detail: basename });
  if (_session.history.length > 50) _session.history.shift();
  _saveSession();

  const totalBytes = _contextBytes();
  const overLimit  = totalBytes > MAX_CONTEXT_BYTES;

  return {
    ok:           true,
    filename:     basename,
    size:         _fmtBytes(stat.size),
    changed:      changed || false,
    overLimit:    overLimit,
    totalContext: _fmtBytes(totalBytes)
  };
}

/**
 * MENGAMBIL isi file mentah (dibutuhkan oleh react-loop.js untuk proses diff & edit).
 * Cari di cache session dulu, kalau nggak ada coba baca dari disk di workspace aktif.
 */
export function getFileContent(filename) {
  if (!filename) return null;
  const basename = path.basename(filename);

  if (_session.loadedFiles[basename]) {
    return _session.loadedFiles[basename].content;
  }
  if (_session.loadedFiles[filename]) {
    return _session.loadedFiles[filename].content;
  }

  // Fallback: baca langsung dari filesystem jika ada
  try {
    const target = _resolvePath(filename);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      const content = fs.readFileSync(target, 'utf8');
      return content;
    }
  } catch (e) {}

  return null;
}

/**
 * UPDATE cache session di memori setelah file diubah/ditulis oleh writer.js
 */
export function setFileContent(filename, content) {
  if (!filename || typeof content !== 'string') return false;
  const target   = _resolvePath(filename);
  const basename = path.basename(target);
  const size     = Buffer.byteLength(content, 'utf8');

  _session.loadedFiles[basename] = {
    content:     content,
    fingerprint: _fingerprint(content),
    size:        size,
    fullPath:    target,
    loadedAt:    new Date().toISOString()
  };
  _saveSession();
  return true;
}

/**
 * Menghapus seluruh file yang dimuat dari cache context
 */
export function clearContext() {
  _session.loadedFiles = {};
  _saveSession();
  return true;
}

/**
 * Mengambil ringkasan context aktif
 */
export function getContext() {
  const totalBytes = _contextBytes();
  const files      = Object.entries(_session.loadedFiles).map(function(entry) {
    return {
      filename:    entry[0],
      size:        _fmtBytes(entry[1].size),
      fingerprint: entry[1].fingerprint
    };
  });

  return {
    activePath:   _session.activePath || null,
    totalContext: _fmtBytes(totalBytes),
    overLimit:    totalBytes > MAX_CONTEXT_BYTES,
    files:        files
  };
}

/**
 * Mengecek apakah ada file di cache yang berubah/dihapus di luar CLI
 */
export function checkFingerprints() {
  const stale = [];
  for (const name in _session.loadedFiles) {
    const f = _session.loadedFiles[name];
    try {
      if (!fs.existsSync(f.fullPath)) {
        stale.push({ filename: name, reason: 'dihapus' });
        continue;
      }
      const current = fs.readFileSync(f.fullPath, 'utf8');
      if (_fingerprint(current) !== f.fingerprint) {
        stale.push({ filename: name, reason: 'berubah sejak dibaca' });
      }
    } catch (e) {
      stale.push({ filename: name, reason: e.message });
    }
  }
  return stale;
}

/**
 * Membangun string context untuk di-inject ke prompt AI
 */
export function buildContextString() {
  const keys = Object.keys(_session.loadedFiles);
  if (keys.length === 0) return null;

  let ctx = '=== FILE CONTEXT ===\n';
  ctx += 'Project: ' + (_session.activePath || 'unknown') + '\n\n';

  for (const name of keys) {
    const f = _session.loadedFiles[name];
    ctx += '--- ' + name + ' (' + _fmtBytes(f.size) + ') ---\n';
    ctx += f.content;
    ctx += '\n\n';
  }

  ctx += '=== END FILE CONTEXT ===\n';
  return ctx;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init() {
  _loadSession();
  return {
    hasSession:  !!_session.activePath,
    activePath:  _session.activePath,
    fileCount:   Object.keys(_session.loadedFiles).length
  };
}

/**
 * Expose the current active project path.
 * Used by lib/writer.js and lib/react-loop.js to resolve relative file targets.
 * @returns {string|null}
 */
export function getActivePath() {
  return _session.activePath || null;
}
