/**
 * K-Router CLI — ReAct Loop Engine
 * Location: /lib/react-loop.js
 *
 * Orchestrates the Reason → Act → Observe loop for autonomous coding tasks.
 * Supports: read files, analyze context, edit/write/delete with HITL approval.
 *
 * HITL flow (called from bin/cli.js):
 *   isPendingApproval()   → true when the loop is paused waiting for y/n/c
 *   resolveApproval(a, c) → unblocks the loop with the user's decision
 *   isRunning()           → true while any task loop is active
 */

import path from 'path';
import * as core   from './core.js';
import * as host   from './host.js';
import * as plan   from './plan.js';
import * as diff   from './diff.js';
import * as writer from './writer.js';
import * as notify from './notify.js';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const BOLD    = '\x1b[1m';
const RED     = '\x1b[31m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const CYAN    = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const MUTED   = '\x1b[90m';

// ── Loop state ────────────────────────────────────────────────────────────────

let _isRunning       = false;
let _pendingApproval = null;   // null | { resolve: Function, description: string }
let _loopCount       = 0;

const MAX_LOOPS      = 5;
const MAX_REVISIONS  = 3;

// ── System prompts ────────────────────────────────────────────────────────────

const EDIT_SYSTEM = `You are a precise code editor.
Given the original file content and an edit task, output ONLY the complete modified file content.
Do NOT add explanations, markdown code fences, or any commentary about changes.
Output the raw file content exactly as it should be written to disk.`;

const WRITE_SYSTEM = `You are a code generator.
Given a task description, output ONLY the complete content of the new file.
Do NOT add explanations, markdown code fences, or commentary.
Output the raw file content exactly as it should be written to disk.`;

// ── HITL public API (called from bin/cli.js) ──────────────────────────────────

export function isPendingApproval() {
  return _pendingApproval !== null;
}

export function isRunning() {
  return _isRunning;
}

/**
 * Resolve a pending HITL approval.
 * Called from bin/cli.js when the user types y / n / c [comment].
 *
 * @param {'y'|'n'|'c'} answer
 * @param {string} [comment]
 */
export function resolveApproval(answer, comment = '') {
  if (!_pendingApproval) return;
  const resolve = _pendingApproval.resolve;
  _pendingApproval = null;
  resolve({ answer: String(answer).toLowerCase().trim(), comment: String(comment).trim() });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Suspend the loop and display an approval prompt.
 * Returns a Promise that resolves when resolveApproval() is called.
 *
 * @param {string}   description - what is being approved
 * @param {Function} onOutput
 * @returns {Promise<{ answer: string, comment: string }>}
 */
function _waitForApproval(description, onOutput) {
  onOutput(`\n${MAGENTA}${BOLD}[?]${R} ${BOLD}Approval required:${R} ${description}`);
  onOutput(`    ${GREEN}y${R} approve  │  ${RED}n${R} reject  │  ${YELLOW}c [comment]${R} revise\n`);

  return new Promise(resolve => {
    _pendingApproval = { resolve, description };
  });
}

/**
 * Call the AI to generate edited file content.
 * Increments loopCount on each call.
 *
 * @param {string} backendUrl
 * @param {string} taskDescription
 * @param {{ type, target, description }} step
 * @param {string} originalContent
 * @returns {Promise<string>} - new file content
 */
async function _generateEdit(backendUrl, taskDescription, step, originalContent) {
  if (_loopCount >= MAX_LOOPS) {
    throw new Error(`Max loops (${MAX_LOOPS}) reached — cannot call AI`);
  }
  _loopCount++;

  const userMsg =
    `File: ${step.target}\n\n` +
    `Original content:\n${originalContent}\n\n` +
    `Edit task: ${step.description}\n` +
    `Overall goal: ${taskDescription}\n\n` +
    `Output the complete new file content:`;

  const messages = [
    { role: 'system', content: EDIT_SYSTEM },
    { role: 'user',   content: userMsg }
  ];

  const result = await core.sendChatRequest(backendUrl, messages);
  const raw = result?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI returned empty response for edit');

  // Strip markdown fences if AI adds them despite instructions
  return raw.replace(/^```[a-zA-Z]*\n?/m, '').replace(/\n?```$/m, '').trim();
}

/**
 * Call the AI to generate new file content.
 *
 * @param {string} backendUrl
 * @param {string} taskDescription
 * @param {{ target, description }} step
 * @param {string|null} fileContext
 * @returns {Promise<string>}
 */
async function _generateNewFile(backendUrl, taskDescription, step, fileContext) {
  if (_loopCount >= MAX_LOOPS) {
    throw new Error(`Max loops (${MAX_LOOPS}) reached — cannot call AI`);
  }
  _loopCount++;

  const userMsg =
    `Task: ${taskDescription}\n` +
    `File to create: ${step.target}\n` +
    `Description: ${step.description}\n` +
    (fileContext ? `\nProject context:\n${fileContext}\n` : '') +
    `\nOutput the complete file content:`;

  const messages = [
    { role: 'system', content: WRITE_SYSTEM },
    { role: 'user',   content: userMsg }
  ];

  const result = await core.sendChatRequest(backendUrl, messages);
  const raw = result?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI returned empty response for file generation');

  return raw.replace(/^```[a-zA-Z]*\n?/m, '').replace(/\n?```$/m, '').trim();
}

// ── Step executors ────────────────────────────────────────────────────────────

async function _execRead(step, loadedNames, onOutput) {
  if (!step.target) {
    onOutput(`${YELLOW}[!]${R} READ step has no target — skipping`);
    return;
  }

  const r = host.readFile(step.target);
  if (!r.ok) {
    onOutput(`${RED}[✗]${R} Cannot read ${step.target}: ${r.error}`);
    return;
  }

  loadedNames.add(r.filename);
  onOutput(`${GREEN}[✓]${R} Read ${r.filename} (${r.size})${r.changed ? `  ${YELLOW}⚠ changed since last load${R}` : ''}`);
}

async function _execAnalyze(step, onOutput) {
  // Analysis happens implicitly — the loaded context is passed to AI in subsequent edit/write calls.
  // This step is a no-op in execution; it signals the plan reader that AI needs to reason.
  onOutput(`${CYAN}[→]${R} Analyze: ${step.description}`);
}

async function _execEdit(backendUrl, taskDescription, step, loadedNames, onOutput) {
  if (!step.target) {
    onOutput(`${YELLOW}[!]${R} EDIT step has no target — skipping`);
    return;
  }

  // Auto-read the target if not already loaded
  const basename = path.basename(step.target);
  if (!loadedNames.has(step.target) && !loadedNames.has(basename)) {
    onOutput(`${CYAN}[→]${R} Auto-reading ${step.target} for edit context...`);
    const r = host.readFile(step.target);
    if (!r.ok) {
      onOutput(`${RED}[✗]${R} Cannot read ${step.target}: ${r.error}`);
      return;
    }
    loadedNames.add(r.filename);
  }

  // Get original content from the host session
  const originalContent = host.getFileContent(basename) || host.getFileContent(step.target);
  if (originalContent === null) {
    onOutput(`${RED}[✗]${R} No content cached for ${step.target} — cannot diff`);
    return;
  }

  onOutput(`${CYAN}[→]${R} Generating edit for ${step.target}...`);

  let newContent;
  try {
    newContent = await _generateEdit(backendUrl, taskDescription, step, originalContent);
  } catch (e) {
    onOutput(`${RED}[✗]${R} Edit generation failed: ${e.message}`);
    return;
  }

  let diffResult = diff.generateDiff(step.target, originalContent, newContent);
  onOutput(diffResult.preview);

  if (!diffResult.hasChanges) {
    onOutput(`${YELLOW}[!]${R} No changes generated — skipping`);
    return;
  }

  notify.notifyHITL(step.target, step.description);

  let revisions = 0;
  while (revisions < MAX_REVISIONS) {
    const approval = await _waitForApproval(
      `Apply edit to ${step.target}  (${GREEN}+${diffResult.added}${R} / ${RED}-${diffResult.removed}${R})`,
      onOutput
    );

    if (approval.answer === 'y') {
      const w = writer.writeFile(step.target, newContent);
      if (w.ok) {
        onOutput(`${GREEN}[✓]${R} Saved ${w.fullPath}`);
        if (w.backup) onOutput(`${MUTED}    backup → ${path.basename(w.backup)}${R}`);
      } else {
        onOutput(`${RED}[✗]${R} Write failed: ${w.error}`);
      }
      return;
    }

    if (approval.answer === 'n') {
      onOutput(`${YELLOW}[!]${R} Edit rejected — ${step.target} unchanged`);
      return;
    }

    if (approval.answer === 'c') {
      revisions++;
      if (_loopCount >= MAX_LOOPS) {
        onOutput(`${YELLOW}[!]${R} Max loops reached — cannot revise`);
        return;
      }

      onOutput(`${CYAN}[→]${R} Revising with comment: "${approval.comment}"`);
      const revisedStep = {
        ...step,
        description: `${step.description}. User correction: ${approval.comment}`
      };

      try {
        newContent = await _generateEdit(backendUrl, taskDescription, revisedStep, originalContent);
      } catch (e) {
        onOutput(`${RED}[✗]${R} Revision failed: ${e.message}`);
        return;
      }

      diffResult = diff.generateDiff(step.target, originalContent, newContent);
      onOutput(diffResult.preview);

      if (!diffResult.hasChanges) {
        onOutput(`${YELLOW}[!]${R} No changes after revision — skipping`);
        return;
      }

      notify.notifyHITL(step.target, `Revised: ${approval.comment}`);
      continue;
    }
  }

  onOutput(`${YELLOW}[!]${R} Max revisions reached — skipping`);
}

async function _execWrite(backendUrl, taskDescription, step, onOutput) {
  if (!step.target) {
    onOutput(`${YELLOW}[!]${R} WRITE step has no target — skipping`);
    return;
  }

  onOutput(`${CYAN}[→]${R} Generating content for new file ${step.target}...`);

  let content;
  try {
    const fileContext = host.buildContextString();
    content = await _generateNewFile(backendUrl, taskDescription, step, fileContext);
  } catch (e) {
    onOutput(`${RED}[✗]${R} Content generation failed: ${e.message}`);
    return;
  }

  const preview = diff.generateNewFileDiff(step.target, content);
  onOutput(preview.preview);

  notify.notifyHITL(step.target, `Create: ${step.description}`);

  const approval = await _waitForApproval(
    `Create new file: ${step.target}  (${GREEN}+${preview.added} lines${R})`,
    onOutput
  );

  if (approval.answer === 'y') {
    const w = writer.writeFile(step.target, content);
    if (w.ok) {
      onOutput(`${GREEN}[✓]${R} Created ${w.fullPath}`);
    } else {
      onOutput(`${RED}[✗]${R} Write failed: ${w.error}`);
    }
  } else if (approval.answer === 'n') {
    onOutput(`${YELLOW}[!]${R} File creation rejected`);
  } else if (approval.answer === 'c') {
    onOutput(`${YELLOW}[!]${R} Revision for WRITE not yet supported — rejecting`);
  }
}

async function _execDelete(step, onOutput) {
  if (!step.target) {
    onOutput(`${YELLOW}[!]${R} DELETE step has no target — skipping`);
    return;
  }

  onOutput(`${RED}${BOLD}[!]${R} DELETE requested: ${step.target} — ${step.description}`);
  notify.notifyHITL(step.target, `DELETE: ${step.description}`);

  const approval = await _waitForApproval(
    `${RED}Permanently delete${R} ${step.target}? (backup will be kept)`,
    onOutput
  );

  if (approval.answer === 'y') {
    const d = writer.deleteFile(step.target);
    if (d.ok) {
      onOutput(`${GREEN}[✓]${R} Deleted ${step.target}`);
      if (d.backup) onOutput(`${MUTED}    backup → ${path.basename(d.backup)}${R}`);
    } else {
      onOutput(`${RED}[✗]${R} Delete failed: ${d.error}`);
    }
  } else {
    onOutput(`${YELLOW}[!]${R} Delete rejected — ${step.target} unchanged`);
  }
}

// ── Step dispatcher ───────────────────────────────────────────────────────────

async function _execStep(backendUrl, taskDescription, step, loadedNames, onOutput) {
  const target = step.target ? ` → ${step.target}` : '';
  onOutput(`\n${MUTED}┄┄ step: ${step.type.toUpperCase()}${target} ┄┄${R}`);

  switch (step.type) {
    case 'read':    return _execRead(step, loadedNames, onOutput);
    case 'analyze': return _execAnalyze(step, onOutput);
    case 'edit':    return _execEdit(backendUrl, taskDescription, step, loadedNames, onOutput);
    case 'write':   return _execWrite(backendUrl, taskDescription, step, onOutput);
    case 'delete':  return _execDelete(step, onOutput);
    default:
      onOutput(`${YELLOW}[!]${R} Unknown step type "${step.type}" — skipping`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Start a ReAct loop for the given task.
 * Non-blocking — runs async in background while cli.js handles HITL input.
 *
 * @param {string}   backendUrl
 * @param {string}   taskDescription
 * @param {Function} onOutput - (message: string) => void  — called for all terminal output
 */
export async function startTask(backendUrl, taskDescription, onOutput) {
  if (_isRunning) {
    onOutput(`${YELLOW}[!]${R} A task is already running. Wait for it to complete.`);
    return;
  }

  _isRunning       = true;
  _loopCount       = 0;
  _pendingApproval = null;

  onOutput(`\n${CYAN}${BOLD}▶ Task:${R} ${taskDescription}`);

  try {
    // Loop iteration 1 — plan generation
    _loopCount++;

    const fileContext = host.buildContextString();
    onOutput(`${CYAN}[→]${R} Generating plan...`);

    const planResult = await plan.generatePlan(backendUrl, taskDescription, fileContext);

    if (!planResult.ok) {
      onOutput(`${RED}[✗]${R} Plan failed: ${planResult.error}`);
      notify.notifyError(`Plan failed: ${planResult.error}`);
      return;
    }

    onOutput(plan.formatPlan(planResult.plan));

    const loadedNames = new Set();

    for (let i = 0; i < planResult.plan.steps.length; i++) {
      if (_loopCount > MAX_LOOPS) {
        onOutput(`\n${YELLOW}[!]${R} Max iterations (${MAX_LOOPS}) reached — stopping early`);
        notify.notifyError(`Max loops hit after ${i}/${planResult.plan.steps.length} steps`);
        return;
      }

      await _execStep(backendUrl, taskDescription, planResult.plan.steps[i], loadedNames, onOutput);
    }

    onOutput(`\n${GREEN}${BOLD}[✓]${R} Task complete.`);
    onOutput(`${MUTED}    ${planResult.plan.impact}${R}\n`);
    notify.notifySuccess(planResult.plan.impact);

  } catch (err) {
    onOutput(`\n${RED}[✗]${R} Fatal: ${err.message}`);
    notify.notifyError(err.message);
  } finally {
    _isRunning       = false;
    _pendingApproval = null;
  }
}