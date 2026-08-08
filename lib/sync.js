/**
 * K-Agent Auto-Sync
 * Location: /lib/sync.js
 *
 * Dua layer backup:
 *   1. rclone → Google Drive (real-time sync saat /exit + daily)
 *   2. git    → GitHub private repo (daily push)
 *
 * Dipanggil dari:
 *   - bin/cli.js saat user ketik /exit
 *   - Termux cron job harian (setup manual sekali)
 */

import { execSync, exec } from 'child_process';
import { promisify }      from 'util';
import path               from 'path';
import fs                 from 'fs';
import os                 from 'os';
import * as logger        from './logger.js';
import * as db            from './db.js';

const execAsync = promisify(exec);

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR        = db.getDataDir();
const GDRIVE_REMOTE   = process.env.RCLONE_REMOTE   || 'KDrive';
const GDRIVE_PATH     = process.env.RCLONE_PATH     || 'krouter-backup';
const GITHUB_REPO_DIR = process.env.BACKUP_REPO_DIR || path.join(os.homedir(), 'krouter-data-backup');
const SYNC_TIMEOUT    = 60000; // 60 detik max per operation

// ─── Status ───────────────────────────────────────────────────────────────────

let _lastSync = null;
let _isSyncing = false;

export function getLastSync() { return _lastSync; }
export function isSyncing()   { return _isSyncing; }

// ─── Google Drive sync via rclone ─────────────────────────────────────────────

async function _syncGDrive(onProgress) {
  const remote = `${GDRIVE_REMOTE}:${GDRIVE_PATH}`;
  const cmd    = `rclone sync "${DATA_DIR}" "${remote}" --create-empty-src-dirs`;

  onProgress && onProgress('Syncing to Google Drive...');
  logger.info('rclone sync → ' + remote);

  try {
    await execAsync(cmd, { timeout: SYNC_TIMEOUT });
    logger.ok('Google Drive sync complete');
    onProgress && onProgress('✓ Google Drive sync complete');
    return { ok: true };
  } catch (err) {
    logger.error('Google Drive sync failed: ' + err.message);
    onProgress && onProgress('✗ Google Drive sync failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// ─── GitHub backup via git ────────────────────────────────────────────────────

async function _syncGitHub(onProgress) {
  // Check if backup repo exists
  if (!fs.existsSync(GITHUB_REPO_DIR)) {
    logger.warn('GitHub backup repo not found at ' + GITHUB_REPO_DIR);
    onProgress && onProgress('⚠ GitHub backup repo not found — skipping git sync');
    return { ok: false, error: 'Backup repo not found' };
  }

  onProgress && onProgress('Pushing to GitHub...');
  logger.info('git push → ' + GITHUB_REPO_DIR);

  try {
    // Copy DB to backup repo
    const dbPath     = db.getDbPath();
    const backupDest = path.join(GITHUB_REPO_DIR, 'krouter.db');

    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupDest);
    }

    // Copy personal + emotional JSON
    const dataFiles = ['personal.json', 'emotional.json'];
    for (const f of dataFiles) {
      const src  = path.join(DATA_DIR, f);
      const dest = path.join(GITHUB_REPO_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, dest);
    }

    // Git commit + push
    const date    = new Date().toISOString().split('T')[0];
    const gitCmds = [
      `git -C "${GITHUB_REPO_DIR}" add -A`,
      `git -C "${GITHUB_REPO_DIR}" commit -m "auto-backup ${date}" --allow-empty`,
      `git -C "${GITHUB_REPO_DIR}" push`
    ];

    for (const cmd of gitCmds) {
      await execAsync(cmd, { timeout: SYNC_TIMEOUT });
    }

    logger.ok('GitHub backup complete');
    onProgress && onProgress('✓ GitHub backup complete');
    return { ok: true };

  } catch (err) {
    // "nothing to commit" is not a real error
    if (err.message && err.message.includes('nothing to commit')) {
      logger.info('GitHub: nothing to commit');
      onProgress && onProgress('✓ GitHub: nothing new to push');
      return { ok: true };
    }
    logger.error('GitHub backup failed: ' + err.message);
    onProgress && onProgress('✗ GitHub backup failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// ─── SQLite vacuum before sync ────────────────────────────────────────────────

function _vacuumDb(onProgress) {
  try {
    db.vacuum();
    logger.info('SQLite vacuum complete');
    onProgress && onProgress('✓ Database optimized');
  } catch (err) {
    logger.warn('Vacuum failed (non-critical): ' + err.message);
  }
}

// ─── Main sync entry points ───────────────────────────────────────────────────

/**
 * Full sync — dipanggil saat /exit
 * Vacuum DB → rclone → git
 */
export async function syncOnExit(onProgress) {
  if (_isSyncing) {
    onProgress && onProgress('Sync already in progress, skipping...');
    return;
  }

  _isSyncing = true;
  onProgress && onProgress('');
  onProgress && onProgress('── Auto-sync starting ──');

  try {
    _vacuumDb(onProgress);

    const [gdrive, github] = await Promise.all([
      _syncGDrive(onProgress),
      _syncGitHub(onProgress)
    ]);

    _lastSync = new Date().toISOString();

    const allOk = gdrive.ok && github.ok;
    onProgress && onProgress('');
    onProgress && onProgress(allOk
      ? '✓ All syncs complete — data backed up'
      : '⚠ Some syncs failed — check logs'
    );

    return { gdrive, github, timestamp: _lastSync };

  } finally {
    _isSyncing = false;
  }
}

/**
 * Daily sync — dipanggil dari cron job
 * Same as syncOnExit tapi dengan log ke file
 */
export async function syncDaily() {
  const logPath = path.join(DATA_DIR, 'sync.log');

  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
  }

  log('Daily sync started');
  const result = await syncOnExit(log);
  log('Daily sync finished');
  return result;
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

/**
 * Cek apakah rclone dan git tersedia
 */
export function checkDependencies() {
  const results = {};

  try {
    execSync('rclone version', { stdio: 'pipe' });
    results.rclone = true;
  } catch {
    results.rclone = false;
  }

  try {
    execSync('git --version', { stdio: 'pipe' });
    results.git = true;
  } catch {
    results.git = false;
  }

  results.backupRepo = fs.existsSync(GITHUB_REPO_DIR);
  results.dataDir    = fs.existsSync(DATA_DIR);

  return results;
}

/**
 * Print sync status — dipanggil dari /sync status command
 */
export function getStatus() {
  const deps = checkDependencies();
  return {
    lastSync:    _lastSync,
    isSyncing:   _isSyncing,
    gdriveRemote: `${GDRIVE_REMOTE}:${GDRIVE_PATH}`,
    backupRepo:  GITHUB_REPO_DIR,
    dataDir:     DATA_DIR,
    deps
  };
}

/**
 * Generate cron job command untuk Termux
 * User jalanin ini sekali untuk setup daily backup
 */
export function getCronSetupCommand() {
  const scriptPath = path.join(DATA_DIR, 'daily-sync.sh');

  const script = `#!/data/data/com.termux/files/usr/bin/bash
# K-Agent Daily Sync
# Generated by K's Router CLI
cd ${GITHUB_REPO_DIR}
node ${path.join(os.homedir(), 'K-sRouter-CLI', 'bin', 'sync-runner.js')}
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return [
    '# Setup daily sync (jalanin sekali):',
    'pkg install cronie',
    'crond',
    `echo "0 3 * * * bash ${scriptPath}" | crontab -`,
    '# Ini akan jalankan sync setiap jam 3 pagi'
  ].join('\n');
}

