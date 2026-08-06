/**
 * K-Agent Local Database
 * Location: /lib/db.js
 *
 * SQLite via better-sqlite3 (synchronous).
 * Replaces Supabase for all agent data storage.
 * Database file: ~/.krouter_data/krouter.db
 */

import { createRequire } from 'module';
import path from 'path';
import fs   from 'fs';
import os   from 'os';

const require = createRequire(import.meta.url);

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(os.homedir(), '.krouter_data');
const DB_PATH  = path.join(DATA_DIR, 'krouter.db');

// ─── Init ─────────────────────────────────────────────────────────────────────

let _db = null;

function _ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function _open() {
  if (_db) return _db;
  _ensureDir();

  const Database = require('better-sqlite3');
  _db = new Database(DB_PATH);

  // Performance settings
  _db.pragma('journal_mode = WAL');   // safer concurrent access
  _db.pragma('synchronous = NORMAL'); // balance safety + speed
  _db.pragma('foreign_keys = ON');

  _createTables();
  return _db;
}

function _createTables() {
  _db.exec(`
    -- Usage logs (dari Supabase usage_logs)
    CREATE TABLE IF NOT EXISTS usage_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT    DEFAULT (datetime('now')),
      provider    TEXT    NOT NULL,
      model       TEXT,
      success     INTEGER DEFAULT 1,
      latency_ms  INTEGER,
      tokens_in   INTEGER,
      tokens_out  INTEGER,
      effort      TEXT    DEFAULT 'medium'
    );

    -- Agent learning (dari Supabase agent_learning)
    CREATE TABLE IF NOT EXISTS agent_learning (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now')),
      error_summary TEXT    NOT NULL,
      solution      TEXT    NOT NULL,
      context       TEXT,
      confidence    INTEGER DEFAULT 80,
      times_applied INTEGER DEFAULT 1
    );

    -- Agent decisions (dari Supabase agent_decisions)
    CREATE TABLE IF NOT EXISTS agent_decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      context    TEXT NOT NULL,
      decision   TEXT NOT NULL,
      reason     TEXT NOT NULL,
      outcome    TEXT,
      project    TEXT
    );

    -- Agent projects (dari Supabase agent_projects)
    CREATE TABLE IF NOT EXISTS agent_projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now')),
      name        TEXT NOT NULL UNIQUE,
      stack       TEXT DEFAULT '[]',
      rules       TEXT DEFAULT '[]',
      notes       TEXT
    );

    -- Conversations (baru — replace in-memory history)
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      session_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      provider   TEXT,
      tokens_in  INTEGER,
      tokens_out INTEGER
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_usage_created    ON usage_logs      (created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_provider   ON usage_logs      (provider);
    CREATE INDEX IF NOT EXISTS idx_learning_conf    ON agent_learning  (confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_decisions_proj   ON agent_decisions (project);
    CREATE INDEX IF NOT EXISTS idx_convos_session   ON conversations   (session_id);
    CREATE INDEX IF NOT EXISTS idx_projects_active  ON agent_projects  (last_active DESC);
  `);
}

// ─── Usage Logs ───────────────────────────────────────────────────────────────

export function insertUsageLog(data) {
  const db = _open();
  return db.prepare(`
    INSERT INTO usage_logs (provider, model, success, latency_ms, tokens_in, tokens_out, effort)
    VALUES (@provider, @model, @success, @latency_ms, @tokens_in, @tokens_out, @effort)
  `).run({
    provider:   data.provider   || 'unknown',
    model:      data.model      || null,
    success:    data.success    ? 1 : 0,
    latency_ms: data.latency_ms || null,
    tokens_in:  data.tokens_in  || null,
    tokens_out: data.tokens_out || null,
    effort:     data.effort     || 'medium'
  });
}

export function getUsageStats(days) {
  const db = _open();
  const d  = Number.isInteger(days) && days > 0 ? days : 7;
  const modifier = `-${d} days`; // Aman karena d dijamin positive integer

  return {
    days:         d,
    total:        db.prepare(`SELECT COUNT(*) as c FROM usage_logs WHERE created_at >= datetime('now', ?)`).get(modifier).c,
    success_rate: (() => {
      const row = db.prepare(`SELECT AVG(success)*100 as r FROM usage_logs WHERE created_at >= datetime('now', ?)`).get(modifier);
      return row.r ? Math.round(row.r) : 100;
    })(),
    by_provider:  db.prepare(`
      SELECT provider, COUNT(*) as requests,
             ROUND(AVG(success)*100) as success_rate,
             ROUND(AVG(latency_ms)) as avg_latency_ms,
             SUM(tokens_in) as tokens_in,
             SUM(tokens_out) as tokens_out
      FROM usage_logs
      WHERE created_at >= datetime('now', ?)
      GROUP BY provider ORDER BY requests DESC
    `).all(modifier)
  };
}

// ─── Agent Learning ───────────────────────────────────────────────────────────

export function insertLearning(data) {
  const db = _open();
  return db.prepare(`
    INSERT INTO agent_learning (error_summary, solution, context, confidence, times_applied)
    VALUES (@error_summary, @solution, @context, @confidence, 1)
  `).run({
    error_summary: data.error_summary || '',
    solution:      data.solution      || '',
    context:       data.context       || null,
    confidence:    data.confidence    || 80
  });
}

export function getLearnings(limit) {
  const db = _open();
  return db.prepare(`
    SELECT * FROM agent_learning
    ORDER BY confidence DESC, times_applied DESC
    LIMIT ?
  `).all(limit || 5);
}

export function incrementLearning(id) {
  const db = _open();
  return db.prepare(`
    UPDATE agent_learning
    SET times_applied = times_applied + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function clearLearnings() {
  return _open().prepare('DELETE FROM agent_learning').run();
}

// ─── Agent Decisions ──────────────────────────────────────────────────────────

export function insertDecision(data) {
  const db = _open();
  return db.prepare(`
    INSERT INTO agent_decisions (context, decision, reason, outcome, project)
    VALUES (@context, @decision, @reason, @outcome, @project)
  `).run({
    context:  data.context  || '',
    decision: data.decision || '',
    reason:   data.reason   || '',
    outcome:  data.outcome  || null,
    project:  data.project  || null
  });
}

export function getDecisions(project, limit) {
  const db = _open();
  if (project) {
    return db.prepare(`
      SELECT * FROM agent_decisions WHERE project = ? ORDER BY created_at DESC LIMIT ?
    `).all(project, limit || 10);
  }
  return db.prepare(`
    SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT ?
  `).all(limit || 10);
}

export function clearDecisions() {
  return _open().prepare('DELETE FROM agent_decisions').run();
}

// ─── Agent Projects ───────────────────────────────────────────────────────────
export function upsertProject(data) {
  const db = _open();
  const existing = db.prepare('SELECT id FROM agent_projects WHERE name = ?').get(data.name);

  if (existing) {
    return db.prepare(`
      UPDATE agent_projects
      SET stack = @stack, rules = @rules, notes = @notes, last_active = datetime('now')
      WHERE name = @name
    `).run({
      name:  data.name,
      stack: JSON.stringify(data.stack || []),
      rules: JSON.stringify(data.rules || []),
      notes: data.notes || null
    });
  }

  return db.prepare(`
    INSERT INTO agent_projects (name, stack, rules, notes, last_active)
    VALUES (@name, @stack, @rules, @notes, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      stack       = excluded.stack,
      rules       = excluded.rules,
      notes       = excluded.notes,
      last_active = datetime('now')
  `).run({
    name:  data.name,
    stack: JSON.stringify(data.stack || []),
    rules: JSON.stringify(data.rules || []),
    notes: data.notes || null
  });
}

export function getProject(name) {
  const db  = _open();
  const row = db.prepare('SELECT * FROM agent_projects WHERE name = ?').get(name);
  if (!row) return null;
  return {
    ...row,
    stack: JSON.parse(row.stack || '[]'),
    rules: JSON.parse(row.rules || '[]')
  };
}

// ─── Conversations ────────────────────────────────────────────────────────────

export function saveMessage(sessionId, role, content, meta) {
  const db = _open();
  return db.prepare(`
    INSERT INTO conversations (session_id, role, content, provider, tokens_in, tokens_out)
    VALUES (@session_id, @role, @content, @provider, @tokens_in, @tokens_out)
  `).run({
    session_id: sessionId,
    role:       role,
    content:    content,
    provider:   (meta && meta.provider)   || null,
    tokens_in:  (meta && meta.tokens_in)  || null,
    tokens_out: (meta && meta.tokens_out) || null
  });
}

export function getConversation(sessionId, limit = 100) {
  const db = _open();
  // Subquery ambil N terakhir (DESC), lalu outer query urutkan kembali (ASC)
  return db.prepare(`
    SELECT role, content FROM (
      SELECT id, role, content FROM conversations
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `).all(sessionId, limit);
}

export function clearConversation(sessionId) {
  return _open().prepare('DELETE FROM conversations WHERE session_id = ?').run(sessionId);
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

export function vacuum() {
  _open().exec('VACUUM');
}

export function getDbPath() {
  return DB_PATH;
}

export function getDataDir() {
  return DATA_DIR;
}

export function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

