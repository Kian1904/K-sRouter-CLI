/**
 * K-Router CLI — Diff Preview Generator
 * Location: /lib/diff.js
 *
 * Pure JS unified diff engine. Zero npm dependencies.
 * Shows changed regions with ±3 context lines, ANSI colored.
 */

const C_RESET = '\x1b[0m';
const C_BOLD  = '\x1b[1m';
const C_RED   = '\x1b[31m';
const C_GREEN = '\x1b[32m';
const C_CYAN  = '\x1b[36m';
const C_MUTED = '\x1b[90m';

const CONTEXT_LINES = 3;
const LOOKAHEAD     = 8;

// ── Internal diff engine ──────────────────────────────────────────────────────

/**
 * Produce a flat list of diff operations between two line arrays.
 * Each item: { type: 'context'|'add'|'remove', content, oldLine?, newLine? }
 */
function _diffLines(oldLines, newLines) {
  const result = [];
  let i = 0, j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      result.push({ type: 'add', content: newLines[j], newLine: j + 1 });
      j++;
      continue;
    }
    if (j >= newLines.length) {
      result.push({ type: 'remove', content: oldLines[i], oldLine: i + 1 });
      i++;
      continue;
    }
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', content: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i++; j++;
      continue;
    }

    // Look-ahead to find the nearest resync point
    let resynced = false;
    for (let delta = 1; delta <= LOOKAHEAD; delta++) {
      // Lines were inserted before old[i]
      if (j + delta < newLines.length && oldLines[i] === newLines[j + delta]) {
        for (let m = 0; m < delta; m++) {
          result.push({ type: 'add', content: newLines[j + m], newLine: j + m + 1 });
        }
        j += delta;
        resynced = true;
        break;
      }
      // Lines were removed before new[j]
      if (i + delta < oldLines.length && oldLines[i + delta] === newLines[j]) {
        for (let m = 0; m < delta; m++) {
          result.push({ type: 'remove', content: oldLines[i + m], oldLine: i + m + 1 });
        }
        i += delta;
        resynced = true;
        break;
      }
    }

    if (!resynced) {
      // No resync found — treat as substitution
      result.push({ type: 'remove', content: oldLines[i], oldLine: i + 1 });
      result.push({ type: 'add',    content: newLines[j], newLine: j + 1 });
      i++; j++;
    }
  }

  return result;
}

/**
 * Trim to only changed lines + CONTEXT_LINES around each change.
 * Inserts separator markers between non-contiguous hunks.
 */
function _withContext(changes) {
  const include = new Set();
  changes.forEach((c, idx) => {
    if (c.type !== 'context') {
      for (let k = Math.max(0, idx - CONTEXT_LINES); k <= Math.min(changes.length - 1, idx + CONTEXT_LINES); k++) {
        include.add(k);
      }
    }
  });

  const sorted = [...include].sort((a, b) => a - b);
  const result = [];
  let prev = -1;

  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) result.push({ type: 'sep' });
    result.push(changes[idx]);
    prev = idx;
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a terminal diff preview between old and new file content.
 *
 * @param {string} filename     - display name for the header
 * @param {string} oldContent   - original file text
 * @param {string} newContent   - proposed new file text
 * @returns {{ preview: string, hasChanges: boolean, added: number, removed: number }}
 */
export function generateDiff(filename, oldContent, newContent) {
  const oldLines = (oldContent || '').split('\n');
  const newLines = (newContent || '').split('\n');

  const all = _diffLines(oldLines, newLines);

  let added = 0, removed = 0;
  all.forEach(c => {
    if (c.type === 'add')    added++;
    if (c.type === 'remove') removed++;
  });

  if (added === 0 && removed === 0) {
    return { preview: `${C_MUTED}(no changes detected)${C_RESET}`, hasChanges: false, added: 0, removed: 0 };
  }

  const hunks = _withContext(all);

  let out = `\n${C_BOLD}${C_CYAN}━━━ diff: ${filename}  `;
  out    += `${C_GREEN}+${added}${C_RESET}${C_BOLD}${C_CYAN} / ${C_RED}-${removed}${C_RESET}${C_BOLD}${C_CYAN} ━━━${C_RESET}\n`;

  for (const c of hunks) {
    if (c.type === 'sep') {
      out += `${C_MUTED}  ···${C_RESET}\n`;
    } else if (c.type === 'add') {
      out += `${C_GREEN}+ ${String(c.newLine).padStart(4)}  ${c.content}${C_RESET}\n`;
    } else if (c.type === 'remove') {
      out += `${C_RED}- ${String(c.oldLine).padStart(4)}  ${c.content}${C_RESET}\n`;
    } else {
      out += `${C_MUTED}  ${String(c.oldLine).padStart(4)}  ${c.content}${C_RESET}\n`;
    }
  }

  return { preview: out, hasChanges: true, added, removed };
}

/**
 * Preview for a brand-new file (no old content).
 * Shows first 25 lines then truncates.
 *
 * @param {string} filename
 * @param {string} content
 * @returns {{ preview: string, hasChanges: true, added: number, removed: 0 }}
 */
export function generateNewFileDiff(filename, content) {
  const lines = (content || '').split('\n');
  const MAX   = 25;

  let out = `\n${C_BOLD}${C_CYAN}━━━ new file: ${filename}  (${lines.length} lines) ━━━${C_RESET}\n`;

  lines.slice(0, MAX).forEach((line, i) => {
    out += `${C_GREEN}+ ${String(i + 1).padStart(4)}  ${line}${C_RESET}\n`;
  });

  if (lines.length > MAX) {
    out += `${C_MUTED}  ... (${lines.length - MAX} more lines not shown)${C_RESET}\n`;
  }

  return { preview: out, hasChanges: true, added: lines.length, removed: 0 };
}