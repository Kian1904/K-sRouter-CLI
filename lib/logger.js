/**
 * K-Router CLI Activity Logger
 * Location: /lib/logger.js
 * 
 * Pencatat aktivitas pipa data terstruktur untuk terminal CLI.
 * Mendukung level: INFO, OK, WARN, ERROR.
 * Seluruh entri dikunci dalam ring buffer lokal (max 200) untuk performa hemat RAM.
 */

const MAX_ENTRIES = 200; // Batas sakral ring buffer[cite: 6]
const _entries    = []; // Tempat nampung log di memori[cite: 6]
const _listeners  = []; // Subs antarmuka terminal[cite: 6]

export const LEVELS = {
  INFO:  'INFO',
  OK:    'OK',
  WARN:  'WARN',
  ERROR: 'ERROR'
}; //[cite: 6]

// ANSI Colors formatting map khusus CLI premium
const COLORS = {
  INFO:  '\x1b[36m', // Cyan
  OK:    '\x1b[32m', // Green
  WARN:  '\x1b[33m', // Yellow
  ERROR: '\x1b[31m', // Red
  RESET: '\x1b[0m'
};

/**
 * Helper internal untuk membuat timestamp jam lokal[cite: 6]
 */
function _ts() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
} //[cite: 6]

/**
 * Pipa utama eksekusi pencatatan data log[cite: 6]
 */
export function log(level, message, meta = null) {
  const entry = {
    ts:      _ts(),
    level:   level,
    message: message,
    meta:    meta
  }; //[cite: 6]

  _entries.push(entry); //[cite: 6]
  
  // Proteksi LMK Android: Potong log terlama kalau over-capacity[cite: 6]
  if (_entries.length > MAX_ENTRIES) _entries.shift(); //[cite: 6]

  const paddedLevel = entry.level.padEnd(5); //[cite: 6]
  const color = COLORS[entry.level] || COLORS.RESET;
  
  // Format visual output: [15:24:02] OK    <- groq · 412ms
  const formatted = `[${entry.ts}] ${color}${paddedLevel}${COLORS.RESET} ${entry.message}`; //[cite: 6]

  // Broadcast data langsung ke CLI interface subscriber secara asinkron (Non-blocking)
  for (let i = 0; i < _listeners.length; i++) {
    try { 
      _listeners[i](entry, formatted); 
    } catch (e) {
      // Gagal broadcast disilent agar tidak memicu infinite crash loop
    }
  }
} //[cite: 6]

// Sugar functions untuk mempermudah pemanggilan modul eksternal[cite: 6]
export function info(message, meta)  { log(LEVELS.INFO,  message, meta); } //[cite: 6]
export function ok(message, meta)    { log(LEVELS.OK,    message, meta); } //[cite: 6]
export function warn(message, meta)  { log(LEVELS.WARN,  message, meta); } //[cite: 6]
export function error(message, meta) { log(LEVELS.ERROR, message, meta); } //[cite: 6]

/**
 * Berlangganan aliran log (Dipakai oleh UI Terminal untuk mencetak status live)[cite: 6]
 */
export function onLog(fn) {
  _listeners.push(fn); //[cite: 6]
  return function unsubscribe() {
    const idx = _listeners.indexOf(fn); //[cite: 6]
    if (idx > -1) _listeners.splice(idx, 1); //[cite: 6]
  };
}

/**
 * Mengambil seluruh salinan log terkompresi di RAM[cite: 6]
 */
export function getEntries() {
  return [..._entries];
}