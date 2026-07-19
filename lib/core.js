/**
 * K-Router CLI Core Request Engine & Cascade Loop
 * Location: /lib/core.js
 * 
 * Mengelola eksekusi pengiriman pesan ke backend remote Vercel.
 * Menangani sistem antrean fallback (cascade) otomatis jika provider utama eror.
 */

import { getState } from './state.js';
import * as circuit from './circuit.js';
import * as providers from './providers.js';
import * as logger from './logger.js';

const TIMEOUT_MS = 20000; // Aturan sakral: 20 detik timeout per provider

/**
 * Mekanisme pembatas waktu koneksi menggunakan AbortController native Node.js
 */
async function _fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await _fetchWithTimeoutRaw(url, options, controller.signal);
    clearTimeout(timerId);
    return res;
  } catch (err) {
    clearTimeout(timerId);
    throw err;
  }
}

// Helper internal untuk memisahkan logika pembungkusan fetch native
async function _fetchWithTimeoutRaw(url, options, signal) {
  return await fetch(url, { ...options, signal });
}

/**
 * Mengirimkan satu request spesifik ke target provider di backend Vercel
 */
async function _executeTargetRequest(backendUrl, providerId, messages, token) {
  const pConfig = providers.getProvider(providerId);
  const pName = pConfig ? pConfig.name : providerId;
  const targetUrl = `${backendUrl.replace(/\/$/, '')}/api/chat`;

  logger.info(`→ ${providerId} · request sent`);
  const startTime = Date.now();

  try {
    const response = await _fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ provider: providerId, messages: messages })
    }, TIMEOUT_MS);

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
    }

    const data = await response.json();
    
    // Sukses: Catat performa dan pulihkan sirkuit pipa AI
    circuit.recordSuccess(providerId);
    logger.ok(`← ${providerId} · ${duration}ms`);
    
    return data;
  } catch (err) {
    const duration = Date.now() - startTime;
    let errMsg = err.message;

    if (err.name === 'AbortError') {
      errMsg = `timeout ${TIMEOUT_MS}ms`;
    }

    // Gagal: Hukum provider dan laporkan ke sirkuit breaker
    circuit.recordFailure(providerId);
    logger.error(`← ${providerId} · ${errMsg}`);
    throw err;
  }
}

/**
 * Pipa Utama K-Router Engine: Mengatur distribusi cascade failover secara dinamis
 */
export async function sendChatRequest(backendUrl, messages) {
  const state = getState();
  const token = state.token;
  const activeProvider = state.activeProvider;

  if (!token) {
    throw new Error('Akses ditolak: Token pendamping keamanan belum di-set.');
  }

  // Skenario Jalur 1: User mengunci satu provider secara manual via perintah /use
  if (activeProvider !== 'auto') {
    if (circuit.isTripped(activeProvider)) {
      logger.warn(`Provider "${activeProvider}" sedang diisolasi sirkuit. Membuka paksa kunci demi perintah user...`);
    }
    return await _executeTargetRequest(backendUrl, activeProvider, messages, token);
  }

  // Skenario Jalur 2: Sistem "auto" berjalan murni menggunakan loop cascade otomatis
  const cascadeQueue = providers.getCascadeOrder(false); // Ambil jalur pipa utama
  
  for (let i = 0; i < cascadeQueue.length; i++) {
    const target = cascadeQueue[i];

    // Lewati provider jika statusnya sedang terisolasi eror (Tripped)
    if (circuit.isTripped(target.id)) {
      continue;
    }

    try {
      return await _executeTargetRequest(backendUrl, target.id, messages, token);
    } catch (e) {
      // Jika ini bukan ujung antrean pipa, cetak tanda beralih otomatis ke cadangan
      if (i < cascadeQueue.length - 1) {
        // Ambil ID provider berikutnya untuk keperluan log kronologis
        const nextTarget = cascadeQueue[i + 1];
        logger.info(`→ ${nextTarget.id} · fallback cascade`);
      }
    }
  }

  // Skenario Jalur 3: Jalur utama habis, aktifkan barikade terakhir (Backup Redflag Providers)
  logger.warn('Seluruh pipa utama lumpuh. Mengaktifkan rute darurat backup redflag...');
  const backupQueue = providers.getCascadeOrder(true).filter(p => p.backup);

  for (let i = 0; i < backupQueue.length; i++) {
    const target = backupQueue[i];
    try {
      return await _executeTargetRequest(backendUrl, target.id, messages, token);
    } catch (e) {
      // Biarkan loop menghabiskan stok cadangan terakhir
    }
  }

  throw new Error('K-Router Total Collapse: Seluruh penyedia AI utama dan cadangan gagal merespon.');
}

/**
 * Melakukan pengecekan kesehatan server backend via HTTP Ping non-token
 */
export async function checkServerStatus(backendUrl) {
  const targetUrl = `${backendUrl.replace(/\/$/, '')}/api/status`;
  const startTime = Date.now();

  try {
    const res = await _fetchWithTimeout(targetUrl, {
  method: 'GET',
  headers: { 'Authorization': 'Bearer ' + getState().token }
}, 15000);
    const duration = Date.now() - startTime;
    return res.ok ? duration : false;
  } catch (e) {
    return false;
  }
}
