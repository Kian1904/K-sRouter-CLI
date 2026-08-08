#!/usr/bin/env node

/**
 * K-Router Sync Runner
 * Location: /bin/sync-runner.js
 *
 * Entry point untuk cron job harian.
 * Memicu sync SQLite → Supabase dan keluar dengan exit code yang tepat.
 *
 * Usage:
 *   node bin/sync-runner.js
 *   # atau via crontab:
 *   0 3 * * * /usr/bin/node /path/to/krouter/bin/sync-runner.js >> /var/log/krouter-sync.log 2>&1
 */

import * as sync from '../lib/sync.js';
import * as db   from '../lib/db.js';

const TIMEOUT_MS = 60_000; // 60 detik — batas aman untuk network call batch

async function main() {
  const startTime = Date.now();
  console.log(`[sync-runner] ${new Date().toISOString()} — Memulai sync harian...`);

  // Race antara syncNow() dan timeout — supaya cron tidak gantung selamanya
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Sync timeout setelah ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([sync.syncNow(), timeoutPromise]);

    const duration = Date.now() - startTime;
    console.log(`[sync-runner] Selesai dalam ${duration}ms.`);

    if (result && result.synced !== undefined) {
      console.log(`[sync-runner] Records synced: ${result.synced}`);
    }
    if (result && result.errors && result.errors.length > 0) {
      console.warn(`[sync-runner] Partial errors (${result.errors.length}):`, result.errors);
      // Partial error bukan alasan exit 1 — data lain sudah sync
    }

    // Vacuum setelah sync untuk reclaim space
    try {
      db.vacuum();
      console.log('[sync-runner] SQLite vacuum selesai.');
    } catch (vacErr) {
      console.warn('[sync-runner] Vacuum gagal (non-fatal):', vacErr.message);
    }

    process.exit(0);
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[sync-runner] GAGAL setelah ${duration}ms:`, err.message);
    process.exit(1);
  } finally {
    // Pastikan koneksi SQLite ditutup sebelum proses mati
    try { db.close(); } catch (_) {}
  }
}

main();
