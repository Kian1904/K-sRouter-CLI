/**
 * K-Router CLI Circuit Breaker Engine
 * Location: /lib/circuit.js
 * 
 * Melacak kegagalan beruntun tiap provider AI di level aplikasi CLI.
 * Jika mencapai 5x eror beruntun, provider di-flag tripped (temporarily unavailable)[cite: 5, 11].
 * Sistem otomatis melakukan bypass/skip cascade dan me-reset status setelah 60 detik.
 */

import { setState } from './state.js';
// Impor logger yang akan kita bangun di langkah berikutnya
import * as logger from './logger.js';

const MAX_FAILURES  = 5;
const RESET_MS      = 60000; // 60 detik

const _counts  = {}; // { providerId: number }
const _tripped = {}; // { providerId: true }
const _timers  = {}; // { providerId: timeoutId }[cite: 5]

/**
 * Mencatat performa sukses provider dan me-reset total hitungan kegagalan[cite: 5]
 */
export function recordSuccess(providerId) {
  _counts[providerId]  = 0;
  _tripped[providerId] = false;
  
  if (_timers[providerId]) {
    clearTimeout(_timers[providerId]);
    delete _timers[providerId];
  }
  
  // Sinkronisasi status aman ke global state store via modern object spread[cite: 5]
  setState({ errorCounts: { ..._counts } }, { caller: 'circuit.recordSuccess' });
}

/**
 * Mencatat kegagalan provider. Jika menembus batas maks, sirkuit diputus![cite: 5]
 */
export function recordFailure(providerId) {
  _counts[providerId] = (_counts[providerId] || 0) + 1; //[cite: 5]

  if (_counts[providerId] >= MAX_FAILURES && !_tripped[providerId]) { //[cite: 5]
    _tripped[providerId] = true; //[cite: 5]
    
    // Kirim sinyal peringatan taktis ke terminal logger internal[cite: 5]
    logger.warn(
      `Sirkuit putus untuk "${providerId}" setelah ${MAX_FAILURES} kegagalan berturut-turut. Rute dialihkan otomatis. Auto-reset dalam 60s.`
    );

    if (_timers[providerId]) clearTimeout(_timers[providerId]); //[cite: 5]
    
    // Daftarkan agenda auto-reset di background event loop Node.js[cite: 5]
    _timers[providerId] = setTimeout(() => {
      reset(providerId);
      logger.info(`Sirkuit auto-reset berhasil dijalankan untuk provider: ${providerId}`); //[cite: 5]
    }, RESET_MS);
  }

  setState({ errorCounts: { ..._counts } }, { caller: 'circuit.recordFailure' }); //[cite: 5]
}

/**
 * Memeriksa apakah provider sedang dalam masa hukuman isolasi[cite: 5]
 */
export function isTripped(providerId) {
  return _tripped[providerId] === true; //[cite: 5]
}

/**
 * Memulihkan status kesehatan provider secara manual atau otomatis[cite: 5]
 */
export function reset(providerId) {
  _counts[providerId]  = 0; //[cite: 5]
  _tripped[providerId] = false; //[cite: 5]
  
  if (_timers[providerId]) {
    clearTimeout(_timers[providerId]); //[cite: 5]
    delete _timers[providerId];
  }
  
  setState({ errorCounts: { ..._counts } }, { caller: 'circuit.reset' }); //[cite: 5]
}

/**
 * Mengambil status kesehatan seluruh pipa provider saat ini[cite: 5]
 */
export function getStatus() {
  const result = {};
  const ids    = Object.keys(_counts); //[cite: 5]
  for (let i = 0; i < ids.length; i++) {
    result[ids[i]] = {
      failures: _counts[ids[i]] || 0, //[cite: 5]
      tripped:  _tripped[ids[i]] === true //[cite: 5]
    };
  }
  return result;
}