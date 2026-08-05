/**
 * K-Agent Shell Executor
 * Location: /lib/shell.js
 *
 * Menjalankan shell command di Termux dengan:
 * - HITL approval sebelum eksekusi (user WAJIB approve)
 * - Timeout protection
 * - Structured output (stdout + stderr + exit code)
 * - Command logging untuk audit trail
 *
 * TIDAK ada whitelist — agent bebas propose command,
 * tapi user yang decide apakah mau dijalankan atau tidak.
 */

import { exec }    from 'child_process';
import { promisify } from 'util';
import * as notify  from './notify.js';
import * as logger  from './logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30000;   // 30 detik default
const MAX_OUTPUT_CHARS   = 8000;    // trim output yang terlalu panjang

// ─── Pending approval state ───────────────────────────────────────────────────

const _pendingApprovals = new Map(); // reqId -> { id, command, reason, cwd, resolve, reject, timer }
export function hasPendingShellApproval() {
  return _pendingCommand !== null;
}

export function hasPendingShellApproval() {
  return _pendingApprovals.size > 0;
}

export function getPendingCommand(reqId = null) {
  if (reqId && _pendingApprovals.has(reqId)) {
    return { ..._pendingApprovals.get(reqId) };
  }

  const first = _pendingApprovals.values().next().value;
  return first ? { ...first } : null;
}

/**
 * Dipanggil dari cli.js saat user ketik y/n/c untuk shell approval
 */
export function resolveShellApproval(answer, comment, reqId = null) {
  if (_pendingApprovals.size === 0) return false;
  
  const ans    = (answer || '').toLowerCase().trim();
  const resolve = _approvalResolve;
  const reject  = _approvalReject;
  const id = reqId || _pendingApprovals.keys().next().value;
  const pending = _pendingApprovals.get(id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  _pendingApprovals.delete(id);

  _pendingCommand  = null;
  _approvalResolve = null;
  _approvalReject  = null;


  const ans = (answer || '').toLowerCase().trim();
  if (ans === 'y') {
    pending.resolve({ approved: true, comment: null });
  } else if (ans === 'c') {
    pending.resolve({ approved: false, comment: comment || null });
  } else {
    pending.resolve({ approved: false, comment: null });
  }

  return true;
}

// ─── Core executor ────────────────────────────────────────────────────────────

/**
 * Jalankan command dengan HITL approval.
 * Selalu minta approval — tidak ada auto-approve untuk shell.
 *
 * @param {string} command     - Shell command yang akan dijalankan
 * @param {string} reason      - Kenapa command ini diperlukan (untuk user)
 * @param {object} opts
 * @param {number} opts.timeout  - Timeout dalam ms (default 30000)
 * @param {string} opts.cwd      - Working directory (default: activePath dari host)
 * @param {function} opts.onOutput - Callback untuk progress output
 * @returns {Promise<ShellResult>}
 */
export async function run(command, reason, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const cwd     = opts.cwd || process.env.HOME;
  const onOutput = opts.onOutput || (() => {});

  // ── Request HITL approval ──────────────────────────────────────────────────

  logger.warn(`Shell request: ${command}`);

  const reqId = crypto.randomUUID(); // <-- Generate ID unik per command

  _pendingCommand = { command, reason, cwd };

  // Trigger notifikasi HITL
  await notify.hitl(`Shell command needs approval [ID: ${reqld.slice(0, 8)}]:\n${command}\nReason: ${reason}`);

  onOutput({
    type:    'hitl',
    message: `⚠ Shell approval required [${reqld.slice(0, 8)}]:\n  Command: ${command}\n  Reason:  ${reason}\n  Type y to run, n to skip, c [comment] to redirect`
  });

  // Tunggu approval dari user (via resolveShellApproval)
  const approval = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    _approvalResolve = resolve;
    _approvalReject  = reject;

    if (_pendingApprovals.has(reqId)) {
        _pendingApprovals.delete(reqId);
        resolve({ approved: false, comment: 'timeout — auto-rejected after 5 minutes' });
      }
    }, 300000);
       _pendingApprovals.set(reqId, { id: reqId, command, reason, cwd, resolve, reject, timer });
  });
    // Auto-reject setelah 5 menit kalau user gak respond
    
  if (!approval.approved) {
    logger.info(`Shell rejected by user${approval.comment ? ': ' + approval.comment : ''}`);
    return {
      approved:  false,
      command:   command,
      comment:   approval.comment,
      stdout:    '',
      stderr:    '',
      exitCode:  null,
      duration:  0,
      error:     null
    };
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  logger.info(`Executing: ${command}`);
  onOutput({ type: 'running', message: `▶ Running: ${command}` });

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 2   // 2MB max output buffer
    });

    const duration = Date.now() - startTime;
    const out      = _trim(stdout);
    const err      = _trim(stderr);

    logger.ok(`Shell done (${duration}ms): ${command}`);

    return {
      approved:  true,
      command:   command,
      comment:   null,
      stdout:    out,
      stderr:    err,
      exitCode:  0,
      duration:  duration,
      error:     null
    };

  } catch (execErr) {
    const duration = Date.now() - startTime;
    const isTimeout = execErr.killed || execErr.code === 'ETIMEDOUT';

    logger.error(`Shell failed (${duration}ms): ${execErr.message}`);

    return {
      approved:  true,
      command:   command,
      comment:   null,
      stdout:    _trim(execErr.stdout || ''),
      stderr:    _trim(execErr.stderr || execErr.message),
      exitCode:  execErr.code || 1,
      duration:  duration,
      error:     isTimeout ? `Timeout after ${timeout}ms` : execErr.message
    };
  }
}

/**
 * Run tanpa HITL — HANYA untuk SAFE COMMANDS.
 * Mencegah command injection dengan menolak chaining operator (&&, ||, ;, |)
 * dan mengeksekusi binary secara langsung via execFile (tanpa subshell).
 *
 * @param {string} file  - Binary name (misal: 'ls', 'cat', 'git')
 * @param {Array}  args  - Array argumen (misal: ['-la', '/tmp'])
 */
export async function runSafe(file, args = [], opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const cwd     = opts.cwd || process.env.HOME;

    // 1. Validasi defensive: Tolak kalau ada karakter operator shell di file/args
  const dangerRegex = /[&|;<>$`]/;
  const fullCmdString = `${file} ${args.join(' ')}`;
  
  if (dangerRegex.test(fullCmdString)) {
    const errorMsg = 'Command injection attempt detected and blocked in runSafe';
    logger.error(errorMsg + `: ${fullCmdString}`);
    return {
      approved: false, command: fullCmdString, stdout: '', stderr: errorMsg,
      exitCode: 1, duration: 0, error: errorMsg
    };
  }

  logger.info(`Safe exec: ${fullCmdString}`);
  const startTime = Date.now();

  try {
    // 2. Gunakan execFileAsync agar tidak diproses oleh eval subshell (/bin/sh)
    const { stdout, stderr } = await execFileAsync(file, args, { cwd, timeout, maxBuffer: 1024 * 1024 });
    return {
      approved:  true,
      command:   fullCmdString,
      stdout:    _trim(stdout),
      stderr:    _trim(stderr),
      exitCode:  0,
      duration:  Date.now() - startTime,
      error:     null
    };
  } catch (err) {
    return {
      approved:  true,
      command:   fullCmdString,
      stdout:    _trim(err.stdout || ''),
      stderr:    _trim(err.stderr || err.message),
      exitCode:  err.code || 1,
      duration:  Date.now() - startTime,
      error:     err.message
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _trim(str) {
  if (!str) return '';
  const s = str.trim();
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return s.slice(0, half) + '\n\n[... output trimmed ...]\n\n' + s.slice(-half);
}
