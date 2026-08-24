/**
 * K-Router CLI — File Writer & Backup Manager
 * Location: /lib/writer.js
 *
 * Menangani operasi penulisan, penghapusan, dan manajemen backup file lokal.
 * Semua modifikasi otomatis membuat backup statis di ~/.krouter_backups.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';

const BACKUP_DIR = path.join(os.homedir(), '.krouter_backups');

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function _fingerprint(content) {
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}

function _fmtBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function _resolvePath(inputPath) {
  if (inputPath.startsWith('~')) return inputPath.replace('~', os.homedir());
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(inputPath);
}

/**
 * Membuat file backup sebelum file asli ditimpa atau dihapus.
 * Format: [nama-asli].[ext].__[hash]__[timestamp].bak
 */
function _createBackup(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    _ensureDir(BACKUP_DIR);
    
    const content = fs.readFileSync(filePath, 'utf8');
    const fp = _fingerprint(content);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    
    const name = `${path.basename(filePath)}.__${fp}__${ts}.bak`;
    const dest = path.join(BACKUP_DIR, name);
    
    fs.writeFileSync(dest, content, 'utf8');
    return dest;
  } catch (e) {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Menulis atau menimpa file. Otomatis backup jika file sudah ada.
 */
export function writeFile(filePath, content) {
  try {
    const target = _resolvePath(filePath);
    _ensureDir(path.dirname(target));
    
    let backup = null;
    if (fs.existsSync(target)) {
      backup = _createBackup(target);
    }
    
    fs.writeFileSync(target, content, 'utf8');
    return {
      ok: true,
      fullPath: target,
      backup: backup ? path.basename(backup) : null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Menghapus file secara permanen. Otomatis backup sebelum dihapus.
 */
export function deleteFile(filePath) {
  try {
    const target = _resolvePath(filePath);
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'File not found' };
    }
    
    const backup = _createBackup(target);
    fs.unlinkSync(target);
    
    return {
      ok: true,
      backup: backup ? path.basename(backup) : null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Menampilkan daftar seluruh file backup yang ada di ~/.krouter_backups
 */
export function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return { backups: [] };
    
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.bak'));
    const backups = files.map(name => {
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      return {
        name,
        size: _fmtBytes(stat.size),
        created: new Date(stat.mtime).toISOString()
      };
    }).sort((a, b) => b.created.localeCompare(a.created));
    
    return { backups };
  } catch (e) {
    return { backups: [] };
  }
}

/**
 * Mengembalikan file dari backup ke folder target.
 */
export function restoreBackup(backupName, targetDir = '.') {
  try {
    const backupPath = path.join(BACKUP_DIR, backupName);
    if (!fs.existsSync(backupPath)) {
      return { ok: false, error: 'Backup not found' };
    }
    
    const content = fs.readFileSync(backupPath, 'utf8');
    
    // Split berdasarkan delimiter '__' agar nama file asli tetap utuh
    const originalName = backupName.split('.__')[0];
    if (!originalName) {
      return { ok: false, error: 'Invalid backup filename format' };
    }

    const targetPath = _resolvePath(path.join(targetDir, originalName));
    _ensureDir(path.dirname(targetPath));
    
    // Backup file eksisting di target sebelum ditimpa hasil restore
    if (fs.existsSync(targetPath)) {
      _createBackup(targetPath);
    }
    
    fs.writeFileSync(targetPath, content, 'utf8');
    return { ok: true, restored: targetPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Inisialisasi direktori backup saat boot
 */
export function init() {
  _ensureDir(BACKUP_DIR);
  return {
    backupDir: BACKUP_DIR,
    hasBackups: fs.existsSync(BACKUP_DIR) && fs.readdirSync(BACKUP_DIR).length > 0
  };
}
