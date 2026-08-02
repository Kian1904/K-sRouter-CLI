/**
 * K-Router CLI — Termux Notification Wrapper
 * Location: /lib/notify.js
 *
 * Wraps the termux-notification CLI command from Termux:API.
 * Degrades silently if Termux:API is not installed — never throws.
 *
 * Prerequisites (one-time setup):
 *   1. Install "Termux:API" app from F-Droid
 *   2. Run: pkg install termux-api
 */

import { exec } from 'child_process';

// Stable notification IDs — reusing the same ID replaces the prior notification
const IDS = {
  success: 7001,
  error:   7002,
  hitl:    7003
};

/**
 * Sanitize string for shell argument (no shell injection).
 */
function _esc(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g,  '\\"')
    .replace(/`/g,  '\\`')
    .replace(/\$/g, '\\$');
}

/**
 * Fire-and-forget termux-notification call.
 * Silently ignores all errors (not in Termux / API not installed).
 *
 * @param {number} id
 * @param {string} title
 * @param {string} message
 * @param {boolean} [vibrate]
 */
function _send(id, title, message, vibrate = true) {
  const vibrateFlag = vibrate ? '--vibrate 300' : '';
  const cmd = `termux-notification --id ${id} --title "${_esc(title)}" --content "${_esc(message)}" ${vibrateFlag}`;

  exec(cmd, { timeout: 4000 }, () => {
    // Intentionally silent — Termux:API absence is not an error
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Notify: task completed successfully.
 * @param {string} summary - one-sentence impact description
 */
export function notifySuccess(summary) {
  _send(IDS.success, '✅ K-Router — Task Done', summary);
}

/**
 * Notify: task failed or max loops reached.
 * @param {string} reason
 */
export function notifyError(reason) {
  _send(IDS.error, '❌ K-Router — Error', reason);
}

/**
 * Notify: HITL approval needed (agent is paused).
 * @param {string} filename   - file being modified
 * @param {string} changeDesc - short description of the proposed change
 */
export function notifyHITL(filename, changeDesc) {
  _send(IDS.hitl, '⏸ K-Router — Approval Needed', `${changeDesc}  →  ${filename}`);
}