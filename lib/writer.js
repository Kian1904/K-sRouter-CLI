/**
 * K-Router CLI — Plan Builder
 * Location: /lib/plan.js
 *
 * Generates a structured execution plan by querying the active AI provider.
 * The plan is a JSON object the ReAct loop executes step by step.
 */

import * as core   from './core.js';
import * as logger from './logger.js';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C_RESET  = '\x1b[0m';
const C_BOLD   = '\x1b[1m';
const C_RED    = '\x1b[31m';
const C_GREEN  = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_CYAN   = '\x1b[36m';
const C_MUTED  = '\x1b[90m';

// ── System Prompt ─────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a coding agent. Given a task, produce a minimal execution plan as JSON.

Output ONLY valid JSON — no markdown fences, no explanation:
{
  "steps": [
    { "type": "read",    "target": "filename.js", "description": "why read this" },
    { "type": "analyze", "target": null,           "description": "what to reason about" },
    { "type": "edit",    "target": "filename.js",  "description": "what change to make" },
    { "type": "write",   "target": "newfile.js",   "description": "what to create" },
    { "type": "delete",  "target": "oldfile.js",   "description": "why delete" }
  ],
  "impact": "One sentence: what this plan accomplishes and what it does NOT touch."
}

Step type rules:
- "read"    → read existing file into context (auto-approved)
- "analyze" → reason about already-loaded content (auto-approved, target = null)
- "edit"    → modify an existing file (requires human approval)
- "write"   → create a new file (requires human approval)
- "delete"  → delete a file (requires human approval)

Constraints:
- Maximum 5 steps total
- Use "edit" not "write" for files that already exist
- Only include steps strictly needed for the task
- "target" must be a filename or relative path, never null except for analyze`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ask the AI to generate a plan for the given task.
 *
 * @param {string}      backendUrl
 * @param {string}      taskDescription
 * @param {string|null} fileContext - optional pre-loaded file context string
 * @returns {Promise<{ ok: boolean, plan?: { steps: Array, impact: string }, error?: string }>}
 */
export async function generatePlan(backendUrl, taskDescription, fileContext) {
  let userMsg = `Task: ${taskDescription}`;
  if (fileContext) {
    userMsg += `\n\nCurrently loaded file context:\n${fileContext}`;
  }

  const messages = [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user',   content: userMsg }
  ];

  let result;
  try {
    result = await core.sendChatRequest(backendUrl, messages);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const raw = result?.choices?.[0]?.message?.content;
  if (!raw) {
    return { ok: false, error: 'AI returned empty response' };
  }

  // Strip markdown fences if the AI adds them despite instructions
  const jsonStr = raw
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim();

  let plan;
  try {
    plan = JSON.parse(jsonStr);
  } catch (e) {
    return { ok: false, error: `AI response is not valid JSON: ${e.message}` };
  }

  if (!Array.isArray(plan.steps) || typeof plan.impact !== 'string') {
    return { ok: false, error: 'AI plan schema mismatch (missing steps[] or impact)' };
  }

  // Normalize + cap steps
  plan.steps = plan.steps.slice(0, 5).map(s => ({
    type:        String(s.type        || 'analyze').toLowerCase().trim(),
    target:      s.target             || null,
    description: String(s.description || '')
  }));

  return { ok: true, plan };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

const TYPE_META = {
  read:    { label: 'READ   ', color: C_GREEN,  approval: 'auto' },
  analyze: { label: 'ANALYZE', color: C_GREEN,  approval: 'auto' },
  edit:    { label: 'EDIT   ', color: C_YELLOW, approval: 'HITL' },
  write:   { label: 'WRITE  ', color: C_YELLOW, approval: 'HITL' },
  delete:  { label: 'DELETE ', color: C_RED,    approval: 'HITL' }
};

/**
 * Format a plan object into a colored terminal string.
 *
 * @param {{ steps: Array, impact: string }} plan
 * @returns {string}
 */
export function formatPlan(plan) {
  let out = `\n${C_BOLD}${C_CYAN}Plan:${C_RESET}\n`;

  plan.steps.forEach((step, i) => {
    const meta   = TYPE_META[step.type] || { label: step.type.padEnd(7).toUpperCase(), color: C_MUTED, approval: '?' };
    const target = step.target ? `  ${C_RESET}→ ${step.target}` : '';
    const badge  = meta.approval === 'auto'
      ? `${C_MUTED}[auto]${C_RESET}`
      : `${C_YELLOW}[HITL]${C_RESET}`;

    out += `  ${C_MUTED}${i + 1}.${C_RESET} `;
    out += `${meta.color}${C_BOLD}${meta.label}${C_RESET}`;
    out += `${meta.color}${target}${C_RESET}`;
    out += `  ${badge}  ${C_MUTED}${step.description}${C_RESET}\n`;
  });

  out += `\n${C_MUTED}Impact: ${plan.impact}${C_RESET}\n`;
  return out;
}