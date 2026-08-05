/**
 * K-Agent Prompt Parser
 * Location: /lib/prompt-parser.js
 *
 * Parse prompt berantakan dari user → structured intent object.
 * Kalau ada ambiguitas, agent assume yang paling masuk akal
 * lalu tampilkan summary untuk di-review user (y/n/c).
 *
 * Output: ParsedIntent object yang jadi input Lead Agent / Orchestrator.
 */

import * as core   from './core.js';
import * as logger from './logger.js';

// ─── Agent config ─────────────────────────────────────────────────────────────
// Gemini Flash — context window besar, bagus untuk analisis intent

const PARSER_PROVIDER = 'google_gemini';
const PARSER_EFFORT   = 'high';

const SYSTEM_PROMPT = `You are a prompt interpreter for an AI agent system.

Your job is to convert a messy, ambiguous, or informal user instruction into a structured JSON object.

Rules:
1. ALWAYS return valid JSON, nothing else
2. If something is unclear, make the most reasonable assumption
3. Never refuse — always produce your best interpretation
4. Keep goal and scope concise and actionable
5. taskType must be one of: debug | build | research | refactor | explain | mixed

Return exactly this JSON structure:
{
  "goal": "one clear sentence of what the user actually wants",
  "taskType": "debug|build|research|refactor|explain|mixed",
  "scope": ["list of files, folders, or systems involved if mentioned"],
  "constraints": ["things user explicitly or implicitly said NOT to do"],
  "urgency": "low|medium|high",
  "assumptions": ["list of assumptions you made for unclear parts"],
  "clarifyNeeded": ["things that are still genuinely ambiguous even after best assumption"]
}`;

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse raw user prompt into structured intent.
 * @param {string} backendUrl
 * @param {string} rawPrompt
 * @returns {Promise<ParsedIntent>}
 */
export async function parse(backendUrl, rawPrompt) {
  logger.info('Prompt Parser → analyzing intent...');

  const messages = [
    {
      role:    'user',
      content: `Parse this user instruction:\n\n"${rawPrompt}"`
    }
  ];

  let raw;
  try {
    const result = await core.sendChatRequest(backendUrl, messages, {
      provider: PARSER_PROVIDER,
      effort:   PARSER_EFFORT
    });
    raw = result.choices?.[0]?.message?.content || '';
  } catch (err) {
    logger.error('Prompt Parser failed: ' + err.message);
    // Fallback: return minimal parsed intent
    return _fallback(rawPrompt);
  }

  // Strip markdown fences if present
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.warn('Prompt Parser: JSON parse failed, using fallback');
    return _fallback(rawPrompt);
  }

  // Validate and normalize
  return _normalize(parsed, rawPrompt);
}

// ─── Format summary for user review ───────────────────────────────────────────

/**
 * Format parsed intent as human-readable summary for HITL review.
 * User sees this and responds y/n/c before Lead Agent starts planning.
 */
export function formatSummary(intent) {
  const lines = [];

  lines.push('');
  lines.push('╔═══════════════════════════════════════════╗');
  lines.push('║         ASSUMPTION SUMMARY                ║');
  lines.push('╚═══════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Goal:      ${intent.goal}`);
  lines.push(`Task type: ${intent.taskType}`);
  lines.push(`Urgency:   ${intent.urgency}`);

  if (intent.scope && intent.scope.length > 0) {
    lines.push(`Scope:     ${intent.scope.join(', ')}`);
  }

  if (intent.constraints && intent.constraints.length > 0) {
    lines.push('');
    lines.push('Constraints:');
    intent.constraints.forEach(c => lines.push(`  - ${c}`));
  }

  if (intent.assumptions && intent.assumptions.length > 0) {
    lines.push('');
    lines.push('Assumptions made:');
    intent.assumptions.forEach(a => lines.push(`  ~ ${a}`));
  }

  if (intent.clarifyNeeded && intent.clarifyNeeded.length > 0) {
    lines.push('');
    lines.push('Still unclear (gue skip dulu):');
    intent.clarifyNeeded.forEach(c => lines.push(`  ? ${c}`));
  }

  lines.push('');
  lines.push('Proceed with this interpretation? (y / n / c [correction])');
  lines.push('');

  return lines.join('\n');
}

// ─── Apply correction ─────────────────────────────────────────────────────────

/**
 * Apply user correction to parsed intent.
 * Called when user responds with 'c [correction text]'
 */
export async function applyCorrection(backendUrl, intent, correction) {
  logger.info('Applying correction to parsed intent...');

  const messages = [
    {
      role:    'user',
      content: `Original parsed intent:\n${JSON.stringify(intent, null, 2)}\n\nUser correction: "${correction}"\n\nUpdate the intent based on the correction and return the full JSON object.`
    }
  ];

  try {
    const result = await core.sendChatRequest(backendUrl, messages, {
      provider: PARSER_PROVIDER,
      effort:   PARSER_EFFORT
    });
    const raw     = result.choices?.[0]?.message?.content || '';
    const cleaned = _extractJson(raw);
    const updated = JSON.parse(cleaned);
    return _normalize(updated, intent._raw || '');
  } catch (err) {
    logger.error('Correction failed: ' + err.message);
    return intent; // return original if correction fails
  }
}

let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.warn('Prompt Parser: JSON parse failed, using fallback');
    return _fallback(rawPrompt);
  }
// ─── Helpers ──────────────────────────────────────────────────────────────────

function _normalize(parsed, rawPrompt) {
  const VALID_TYPES    = ['debug', 'build', 'research', 'refactor', 'explain', 'mixed'];
  const VALID_URGENCY  = ['low', 'medium', 'high'];

  return {
    goal:          (parsed.goal          || rawPrompt).trim(),
    taskType:      VALID_TYPES.includes(parsed.taskType) ? parsed.taskType : 'mixed',
    scope:         Array.isArray(parsed.scope)        ? parsed.scope        : [],
    constraints:   Array.isArray(parsed.constraints)  ? parsed.constraints  : [],
    urgency:       VALID_URGENCY.includes(parsed.urgency) ? parsed.urgency  : 'medium',
    assumptions:   Array.isArray(parsed.assumptions)  ? parsed.assumptions  : [],
    clarifyNeeded: Array.isArray(parsed.clarifyNeeded)? parsed.clarifyNeeded: [],
    _raw:          rawPrompt,
    _parsedAt:     new Date().toISOString()
  };
}

function _fallback(rawPrompt) {
  return {
    goal:          rawPrompt,
    taskType:      'mixed',
    scope:         [],
    constraints:   [],
    urgency:       'medium',
    assumptions:   ['Could not parse intent — using raw prompt as goal'],
    clarifyNeeded: [],
    _raw:          rawPrompt,
    _parsedAt:     new Date().toISOString()
  };
}

/**
 * Robust JSON extractor: ambil outermost JSON object, abaikan chatty preamble LLM
 */
function _extractJson(raw) {
  if (!raw) return '';
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? match[0] : raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
}
