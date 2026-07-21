/**
 * K-Router Agent Memory System
 * Location: /lib/memory.js
 *
 * Hybrid memory:
 *   Local  (~/.krouter_memory/) → personal + emotional (sensitive)
 *   Remote (Supabase)           → learning + decisions + projects
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMORY_DIR    = path.join(os.homedir(), '.krouter_memory');
const PERSONAL_PATH = path.join(MEMORY_DIR, 'personal.json');
const EMOTIONAL_PATH = path.join(MEMORY_DIR, 'emotional.json');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function _supabaseGet(table, query) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}&limit=20`;
    const res = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type':  'application/json'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function _supabaseInsert(table, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify(data)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function _supabaseUpdate(table, id, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method:  'PATCH',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify(data)
    });
    return res.ok;
  } catch (e) {
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
  const emotional  = getEmotional();
  emotional.last_seen = new Date().toISOString();
  emotional.session_count = (emotional.session_count || 0) + 1;
  _writeJSON(EMOTIONAL_PATH, emotional);

  // Return context for agent
  const isLate = _isLateNight(emotional.late_threshold);
  return {
    isLate:       isLate,
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
  emotional.avg_session_min = Math.round(totalMin / emotional.mood_history.length);

  _writeJSON(EMOTIONAL_PATH, emotional);
}

export function setLateThreshold(hhmm) {
  const emotional = getEmotional();
  emotional.late_threshold = hhmm;
  return _writeJSON(EMOTIONAL_PATH, emotional);
}

// ─── Learning Memory (Supabase) ───────────────────────────────────────────────

export async function getLearnings(limit) {
  const n = limit || 5;
  return await _supabaseGet(
    'agent_learning',
    `order=confidence.desc,times_applied.desc&limit=${n}`
  ) || [];
}

export async function saveLearning(errorSummary, solution, context, confidence) {
  return await _supabaseInsert('agent_learning', {
    error_summary: errorSummary,
    solution:      solution,
    context:       context || null,
    confidence:    confidence || 80,
    times_applied: 1
  });
}

export async function incrementLearning(id) {
  // Called when a known solution is applied again
  return await _supabaseUpdate('agent_learning', id, {
    times_applied: null  // handled by DB trigger or manual fetch+update
  });
}

// ─── Decision Memory (Supabase) ───────────────────────────────────────────────

export async function saveDecision(context, decision, reason, project) {
  return await _supabaseInsert('agent_decisions', {
    context:  context,
    decision: decision,
    reason:   reason,
    project:  project || null
  });
}

export async function getDecisions(project) {
  const query = project
    ? `project=eq.${encodeURIComponent(project)}&order=created_at.desc`
    : `order=created_at.desc`;
  return await _supabaseGet('agent_decisions', query) || [];
}

// ─── Project Memory (Supabase) ────────────────────────────────────────────────

export async function getProject(name) {
  const results = await _supabaseGet(
    'agent_projects',
    `name=eq.${encodeURIComponent(name)}`
  );
  return results && results.length > 0 ? results[0] : null;
}

export async function saveProject(name, stack, rules, notes) {
  const existing = await getProject(name);
  if (existing) {
    return await _supabaseUpdate('agent_projects', existing.id, {
      stack:       stack || existing.stack,
      rules:       rules || existing.rules,
      notes:       notes || existing.notes,
      last_active: new Date().toISOString()
    });
  }
  return await _supabaseInsert('agent_projects', {
    name:  name,
    stack: stack || [],
    rules: rules || [],
    notes: notes || null
  });
}

// ─── Context Builder ──────────────────────────────────────────────────────────
// Builds the memory injection string sent to AI before every chat

export async function buildMemoryContext(projectName) {
  const personal   = getPersonal();
  const emotional  = getEmotional();
  const learnings  = await getLearnings(5);
  const decisions  = projectName ? await getDecisions(projectName) : [];
  const project    = projectName ? await getProject(projectName) : null;

  const isLate     = _isLateNight(emotional.late_threshold);
  const avgSession = emotional.avg_session_min || 0;

  let ctx = '=== AGENT MEMORY ===\n\n';

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

  export async function clearAllMemory() {
  await Promise.all([
    clearSessionMemory(),
    clearWorkingMemory(),
    clearPersonalMemory(),
    clearLearningMemory(),
    clearDecisionMemory(),
    clearProjectMemory()
  ]);

  return true;
  }

  export async function clearSessionMemory() {
    conversationHistory = [];
  }

  ctx += '\n=== END AGENT MEMORY ===\n';
  return ctx;
}

// ─── Setup wizard (first boot) ────────────────────────────────────────────────

export function isFirstBoot() {
  return !fs.existsSync(PERSONAL_PATH);
}
