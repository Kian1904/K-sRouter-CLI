/**
 * K-Router Agent Memory System
 * Location: /lib/memory.js
 *
 * Hybrid memory:
 *   Local  (~/.krouter_memory/) → personal + emotional (sensitive)
 *   Remote (SQLite via db.js)   → learning + decisions + projects
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import * as db from './db.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMORY_DIR     = path.join(os.homedir(), '.krouter_memory');
const PERSONAL_PATH  = path.join(MEMORY_DIR, 'personal.json');
const EMOTIONAL_PATH = path.join(MEMORY_DIR, 'emotional.json');

const MOOD_RING_BUFFER_DAYS = 30;

// ─── Init ─────────────────────────────────────────────────────────────────────

function _ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function _defaultPersonal() {
  return {
    nickname:          null,
    timezone:          Intl.DateTimeFormat().resolvedOptions().timeZone,
    work_hours:        { start: '09:00', end: '23:00' },
    peak_hours:        [],
    stack:             [],
    personality_notes: [],
    created_at:        new Date().toISOString()
  };
}

function _defaultEmotional() {
  return {
    late_threshold:  '00:00',
    fatigue_signals: [],
    mood_history:    [],
    last_seen:       null,
    session_count:   0,
    avg_session_min: 0
  };
}

// ─── Local read/write ─────────────────────────────────────────────────────────

function _readJSON(filepath, defaults) {
  try {
    if (!fs.existsSync(filepath)) return defaults;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    return defaults;
  }
}

function _writeJSON(filepath, data) {
  try {
    _ensureDir();
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[MEMORY] Write failed:', e.message);
    return false;
  }
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function _currentHHMM() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' +
         now.getMinutes().toString().padStart(2, '0');
}

function _isLateNight(threshold) {
  const [th, tm] = (threshold || '00:00').split(':').map(Number);
  const now      = new Date();
  const h        = now.getHours();
  const m        = now.getMinutes();
  const nowMins  = h * 60 + m;
  const thrMins  = th * 60 + tm;

  // "Late" = setelah threshold (misal 00:00) sampai 06:00
  return nowMins >= thrMins || h < 6;
}

// ─── Personal Memory ──────────────────────────────────────────────────────────

export function getPersonal() {
  return _readJSON(PERSONAL_PATH, _defaultPersonal());
}

export function savePersonal(data) {
  const current = getPersonal();
  return _writeJSON(PERSONAL_PATH, { ...current, ...data });
}

export function addPersonalityNote(note) {
  const personal = getPersonal();
  personal.personality_notes = personal.personality_notes || [];
  personal.personality_notes.push({
    note:       note,
    created_at: new Date().toISOString()
  });
  // Keep last 50 notes
  if (personal.personality_notes.length > 50) {
    personal.personality_notes = personal.personality_notes.slice(-50);
  }
  return _writeJSON(PERSONAL_PATH, personal);
}

// ─── Emotional Memory ─────────────────────────────────────────────────────────

export function getEmotional() {
  return _readJSON(EMOTIONAL_PATH, _defaultEmotional());
}

export function recordSessionStart() {
  const emotional     = getEmotional();
  emotional.last_seen = new Date().toISOString();
  emotional.session_count = (emotional.session_count || 0) + 1;
  _writeJSON(EMOTIONAL_PATH, emotional);

  return {
    isLate:       _isLateNight(emotional.late_threshold),
    currentTime:  _currentHHMM(),
    sessionCount: emotional.session_count,
    lastSeen:     emotional.last_seen
  };
}

export function recordSessionEnd(durationMinutes) {
  const emotional = getEmotional();

  // Update mood history (ring buffer)
  emotional.mood_history = emotional.mood_history || [];
  emotional.mood_history.push({
    date:         new Date().toISOString().split('T')[0],
    time:         _currentHHMM(),
    duration_min: durationMinutes,
    late_session: _isLateNight(emotional.late_threshold)
  });

  // Keep last N days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MOOD_RING_BUFFER_DAYS);
  emotional.mood_history = emotional.mood_history.filter(function(m) {
    return new Date(m.date) > cutoff;
  });

  // Update avg session duration
  const totalMin = emotional.mood_history.reduce(function(acc, m) {
    return acc + (m.duration_min || 0);
  }, 0);
  emotional.avg_session_min = emotional.mood_history.length > 0
    ? Math.round(totalMin / emotional.mood_history.length)
    : 0;

  _writeJSON(EMOTIONAL_PATH, emotional);
}

export function setLateThreshold(hhmm) {
  const emotional = getEmotional();
  emotional.late_threshold = hhmm;
  return _writeJSON(EMOTIONAL_PATH, emotional);
}

// ─── Learning Memory (SQLite) ─────────────────────────────────────────────────

export async function getLearnings(limit) {
  try {
    return db.getLearnings(limit || 5);
  } catch (e) {
    console.error('[MEMORY] getLearnings failed:', e.message);
    return [];
  }
}

export async function saveLearning(errorSummary, solution, context, confidence) {
  try {
    db.insertLearning({
      error_summary: errorSummary,
      solution:      solution,
      context:       context  || null,
      confidence:    confidence || 80
    });
    return true;
  } catch (e) {
    console.error('[MEMORY] saveLearning failed:', e.message);
    return false;
  }
}

export async function incrementLearning(id) {
  try {
    db.incrementLearning(id);
    return true;
  } catch (e) {
    console.error('[MEMORY] incrementLearning failed:', e.message);
    return false;
  }
}

// ─── Decision Memory (SQLite) ─────────────────────────────────────────────────

export async function saveDecision(context, decision, reason, project) {
  try {
    db.insertDecision({
      context:  context  || '',
      decision: decision || '',
      reason:   reason   || '',
      project:  project  || null
    });
    return true;
  } catch (e) {
    console.error('[MEMORY] saveDecision failed:', e.message);
    return false;
  }
}

export async function getDecisions(project) {
  try {
    return db.getDecisions(project || null, 10);
  } catch (e) {
    console.error('[MEMORY] getDecisions failed:', e.message);
    return [];
  }
}

// ─── Project Memory (SQLite) ──────────────────────────────────────────────────

export async function getProject(name) {
  try {
    return db.getProject(name);
  } catch (e) {
    console.error('[MEMORY] getProject failed:', e.message);
    return null;
  }
}

export async function saveProject(name, stack, rules, notes) {
  try {
    const existing = db.getProject(name);
    db.upsertProject({
      name:  name,
      stack: stack || (existing && existing.stack) || [],
      rules: rules || (existing && existing.rules) || [],
      notes: notes || (existing && existing.notes) || null
    });
    return true;
  } catch (e) {
    console.error('[MEMORY] saveProject failed:', e.message);
    return false;
  }
}

// ─── Context Builder ──────────────────────────────────────────────────────────
// Builds the memory injection string sent to AI before every chat

export async function buildMemoryContext(projectName) {
  const personal  = getPersonal();
  const emotional = getEmotional();

  // getLearnings/getDecisions/getProject sekarang sync via db — await tetap aman
  const learnings = await getLearnings(5);
  const decisions = projectName ? await getDecisions(projectName) : [];
  const project   = projectName ? await getProject(projectName)   : null;

  const isLate     = _isLateNight(emotional.late_threshold);
  const avgSession = emotional.avg_session_min || 0;

  // IDENTITY FRAMING
  let ctx = '=== CONTEXT ABOUT THE USER (bukan tentang kamu) ===\n';
  ctx += 'Kamu adalah AI assistant. Informasi berikut adalah tentang USER yang sedang berbicara denganmu.\n';
  ctx += 'Jangan pernah mengaku sebagai user atau mengadopsi identitas user.\n\n';

  // Personal
  if (personal.nickname) {
    ctx += `User: ${personal.nickname}\n`;
  }
  ctx += `Timezone: ${personal.timezone}\n`;
  ctx += `Current time: ${_currentHHMM()}\n`;
  if (isLate) ctx += `Status: LATE SESSION — user mungkin lelah, gunakan response yang lebih ringkas dan supportive.\n`;
  if (personal.stack && personal.stack.length > 0) {
    ctx += `Tech stack: ${personal.stack.join(', ')}\n`;
  }
  if (personal.work_hours) {
    ctx += `Work hours: ${personal.work_hours.start} - ${personal.work_hours.end}\n`;
  }
  if (avgSession > 0) {
    ctx += `Avg session: ${avgSession} minutes\n`;
  }

  // Personality notes (last 5)
  if (personal.personality_notes && personal.personality_notes.length > 0) {
    const recent = personal.personality_notes.slice(-5);
    ctx += '\nPersonality notes:\n';
    recent.forEach(function(n) { ctx += `  - ${n.note}\n`; });
  }

  // Learnings
  if (learnings.length > 0) {
    ctx += '\nPast learnings (apply if relevant):\n';
    learnings.forEach(function(l) {
      ctx += `  [${l.confidence}%] ${l.error_summary} → ${l.solution}\n`;
    });
  }

  // Project context
  if (project) {
    ctx += `\nActive project: ${project.name}\n`;
    if (project.stack && project.stack.length > 0) {
      ctx += `Project stack: ${project.stack.join(', ')}\n`;
    }
    if (project.rules && project.rules.length > 0) {
      ctx += `Project rules: ${project.rules.join(', ')}\n`;
    }
    if (project.notes) ctx += `Project notes: ${project.notes}\n`;
  }

  // Recent decisions
  if (decisions.length > 0) {
    ctx += '\nRecent decisions:\n';
    decisions.slice(0, 3).forEach(function(d) {
      ctx += `  - ${d.decision} (reason: ${d.reason})\n`;
    });
  }

  ctx += '\n=== END AGENT MEMORY ===\n';
  return ctx;
}

// ─── Setup wizard (first boot) ────────────────────────────────────────────────

export function isFirstBoot() {
  return !fs.existsSync(PERSONAL_PATH);
}

// ─── Memory Eraser ────────────────────────────────────────────────────────────

export function clearPersonalMemory() {
  return _writeJSON(PERSONAL_PATH, _defaultPersonal());
}

export function clearEmotionalMemory() {
  return _writeJSON(EMOTIONAL_PATH, _defaultEmotional());
}

export async function clearLearningMemory() {
  try {
    db.clearLearnings();
    return true;
  } catch (e) {
    console.error('[MEMORY] clearLearningMemory failed:', e.message);
    return false;
  }
}

export async function clearDecisionMemory() {
  try {
    db.clearDecisions();
    return true;
  } catch (e) {
    console.error('[MEMORY] clearDecisionMemory failed:', e.message);
    return false;
  }
}

export async function clearProjectMemory() {
  try {
    db.clearProjects();
    return true;
  } catch (e) {
    console.error('[MEMORY] clearProjectMemory failed:', e.message);
    return false;
  }
}

export async function purgeAllMemory() {
  clearPersonalMemory();
  clearEmotionalMemory();
  await clearLearningMemory();
  await clearDecisionMemory();
  await clearProjectMemory();
  return true;
}
