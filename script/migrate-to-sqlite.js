/**
 * K-Agent Migration Script
 * Location: /scripts/migrate-to-sqlite.js
 *
 * One-time migration dari Supabase ke SQLite lokal.
 * Jalankan SEKALI: node scripts/migrate-to-sqlite.js
 *
 * Yang dimigrasikan:
 *   - usage_logs
 *   - agent_learning
 *   - agent_decisions
 *   - agent_projects
 */

import * as db from '../lib/db.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY harus di-set di env.');
  console.error('Pastiin .env atau ~/.bashrc lo punya kedua variable ini.');
  process.exit(1);
}

// ─── Supabase fetch helper ─────────────────────────────────────────────────────

async function fetchAll(table) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&order=id.asc&limit=10000`;
  const res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch ${table}: ${res.status} ${text}`);
  }

  return res.json();
}

// ─── Migration functions ───────────────────────────────────────────────────────

async function migrateUsageLogs() {
  process.stdout.write('Migrating usage_logs... ');
  const rows = await fetchAll('usage_logs');

  let count = 0;
  for (const row of rows) {
    try {
      db.insertUsageLog({
        provider:   row.provider,
        model:      row.model,
        success:    row.success,
        latency_ms: row.latency_ms,
        tokens_in:  row.tokens_in,
        tokens_out: row.tokens_out,
        effort:     row.effort || 'medium'
      });
      count++;
    } catch (e) {
      // skip individual row errors
    }
  }

  console.log(`✓ ${count}/${rows.length} rows`);
  return count;
}

async function migrateAgentLearning() {
  process.stdout.write('Migrating agent_learning... ');
  const rows = await fetchAll('agent_learning');

  let count = 0;
  for (const row of rows) {
    try {
      db.insertLearning({
        error_summary: row.error_summary,
        solution:      row.solution,
        context:       row.context,
        confidence:    row.confidence || 80
      });
      count++;
    } catch (e) {}
  }

  console.log(`✓ ${count}/${rows.length} rows`);
  return count;
}

async function migrateAgentDecisions() {
  process.stdout.write('Migrating agent_decisions... ');
  const rows = await fetchAll('agent_decisions');

  let count = 0;
  for (const row of rows) {
    try {
      db.insertDecision({
        context:  row.context,
        decision: row.decision,
        reason:   row.reason,
        outcome:  row.outcome,
        project:  row.project
      });
      count++;
    } catch (e) {}
  }

  console.log(`✓ ${count}/${rows.length} rows`);
  return count;
}

async function migrateAgentProjects() {
  process.stdout.write('Migrating agent_projects... ');
  const rows = await fetchAll('agent_projects');

  let count = 0;
  for (const row of rows) {
    try {
      db.upsertProject({
        name:  row.name,
        stack: Array.isArray(row.stack) ? row.stack : JSON.parse(row.stack || '[]'),
        rules: Array.isArray(row.rules) ? row.rules : JSON.parse(row.rules || '[]'),
        notes: row.notes
      });
      count++;
    } catch (e) {}
  }

  console.log(`✓ ${count}/${rows.length} rows`);
  return count;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     K-Agent: Supabase → SQLite Migration  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`Database: ${db.getDbPath()}`);
  console.log('');

  try {
    const results = await Promise.allSettled([
      migrateUsageLogs(),
      migrateAgentLearning(),
      migrateAgentDecisions(),
      migrateAgentProjects()
    ]);

    const failed = results.filter(r => r.status === 'rejected');

    console.log('');
    if (failed.length === 0) {
      console.log('✓ Migration complete. Semua data sudah di SQLite lokal.');
      console.log('');
      console.log('Next steps:');
      console.log('  1. Verify data: sqlite3 ~/.krouter_data/krouter.db ".tables"');
      console.log('  2. Test CLI: krouter → /dashboard');
      console.log('  3. Kalau semua oke, hapus data di Supabase (opsional)');
    } else {
      console.log(`⚠ Migration selesai dengan ${failed.length} error.`);
      failed.forEach(f => console.error('  ✗', f.reason.message));
    }
    console.log('');

  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();

