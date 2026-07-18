/**
 * K-Router CLI Global State Store
 * Location: /lib/state.js
 * 
 * Single source of truth untuk seluruh state aplikasi CLI.
 * Sesuai aturan: Mutasi WAJIB lewat setState() dengan menyertakan metadata caller.
 */

// State Internal Terisolasi (Sandboxed)
const _state = {
  token:          null,
  activeProvider: 'auto',
  chatHistory:    [],
  isLoading:      false,
  errorCounts:    {},   // { providerId: number } — untuk circuit breaker
  lastActivity:   null  // ISO timestamp respon sukses terakhir
};

const _subscribers = [];
const _mutationLog = [];

// Flag debug di CLI bisa diaktifkan via environment variable (e.g., KR_DEBUG=1 krouter)
const DEBUG = process.env.KR_DEBUG === '1';

/**
 * Tracing system untuk memantau mutasi state di terminal backend
 */
function _trace(caller, partial, prev) {
  const entry = {
    ts:     new Date().toISOString(),
    caller: caller || 'UNKNOWN — missing meta.caller',
    keys:   Object.keys(partial),
    prev:   JSON.parse(JSON.stringify(prev)),
    next:   JSON.parse(JSON.stringify(_state))
  };
  
  _mutationLog.push(entry);
  
  // Ring Buffer: Kunci di 50 baris log untuk hemat RAM Termux HP
  if (_mutationLog.length > 50) _mutationLog.shift(); 
  
  if (DEBUG) {
    console.error(`\x1b[33m[DEBUG STATE]\x1b[0m ${entry.caller} memutasi kunci: [${entry.keys.join(', ')}]`);
  }
}

/**
 * Mengambil salinan data state yang bersifat Immutable
 */
export function getState() {
  return JSON.parse(JSON.stringify(_state));
}

/**
 * Mengubah data state dan memicu re-render otomatis pada subscriber
 */
export function setState(partial, meta) {
  if (!meta || typeof meta.caller !== 'string') {
    console.warn('\x1b[33m[STATE WARN] Terjadi mutasi tanpa menyertakan objek { caller: "nama_modul" }.\x1b[0m');
  }

  const prev = JSON.parse(JSON.stringify(_state));
  
  // Merger partial data secara presisi
  for (const key in partial) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) {
      _state[key] = partial[key];
    }
  }

  // Lakukan tracing mutasi
  _trace(meta ? meta.caller : null, partial, prev);

  // Picu semua fungsi subscriber (seperti UI renderer terminal)
  for (let i = 0; i < _subscribers.length; i++) {
    try {
      _subscribers[i](_state, prev);
    } catch (e) {
      console.error('[STATE ERROR] Gagal mengeksekusi fungsi subscriber:', e);
    }
  }
}

/**
 * Mendaftarkan fungsi UI agar ikut mendengarkan setiap perubahan state
 */
export function subscribe(fn) {
  _subscribers.push(fn);
  return function unsubscribe() {
    const idx = _subscribers.indexOf(fn);
    if (idx > -1) _subscribers.splice(idx, 1);
  };
}

/**
 * Mengambil rekam jejak mutasi untuk keperluan audit internal compiler
 */
export function getMutationLog() {
  return [..._mutationLog];
}