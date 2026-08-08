/**
 * K-Router CLI Core Request Engine & Cascade Loop
 * Location: /lib/core.js
 *
 * Mengelola eksekusi pengiriman pesan ke backend remote Vercel.
 * Menangani sistem antrean fallback (cascade) otomatis jika provider utama eror.
 * Dilengkapi smart-detection agar tidak mempolusi system prompt autonomous agent.
 */

import { getState } from './state.js';
import * as circuit  from './circuit.js';
import * as providers from './providers.js';
import * as logger   from './logger.js';
import * as memory   from './memory.js';
import * as db       from './db.js';

const DEFAULT_TIMEOUT_MS = 60000; // 60 detik
const STATUS_TIMEOUT_MS  = 15000; // 15 detik untuk cek status server

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

async function _fetchWithTimeoutRaw(url, options, signal) {
  return await fetch(url, { ...options, signal });
}

/**
 * Mengecek apakah system prompt adalah instruksi ketat agent/task (plan/edit/write)
 * yang melarang polusi context dari personal memory.
 */
function _isStrictAgentPrompt(messages) {
  if (!messages || !messages.length) return false;
  const first = messages[0];
  if (first.role !== 'system' || typeof first.content !== 'string') return false;

  const text = first.content.toLowerCase();
  return (
    text.includes('output only valid json') ||
    text.includes('output only the complete') ||
    text.includes('do not add explanations') ||
    text.includes('you are a coding agent') ||
    text.includes('you are a precise code editor') ||
    text.includes('you are a code generator')
  );
}

/**
 * Catat usage log ke SQLite — fire-and-forget (tidak boleh crash caller).
 */
function _writeLog(data) {
  try {
    db.insertUsageLog(data);
  } catch (e) {
    // Sengaja dibungkam — log failure tidak boleh mengganggu alur utama
    logger.warn('Usage log gagal ditulis: ' + e.message);
  }
}

/**
 * Mengirimkan satu request spesifik ke target provider di backend Vercel
 */
async function _executeTargetRequest(backendUrl, providerId, messages, token, effort, timeoutMs) {
  const targetUrl = `${backendUrl.replace(/\/$/, '')}/api/chat`;

  logger.info(`→ ${providerId} · request sent`);
  const startTime = Date.now();

  try {
    const response = await _fetchWithTimeout(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        provider: providerId,
        messages: messages,
        effort:   effort || 'medium'
      })
    }, timeoutMs);

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
    }

    const data = await response.json();

    // Sukses: catat ke SQLite + pulihkan sirkuit pipa AI
    circuit.recordSuccess(providerId);
    logger.ok(`← ${providerId} · ${duration}ms`);

    _writeLog({
      provider:   providerId,
      model:      data.model                             || null,
      success:    true,
      latency_ms: duration,
      tokens_in:  data.usage && data.usage.prompt_tokens     || null,
      tokens_out: data.usage && data.usage.completion_tokens || null,
      effort:     effort || 'medium'
    });

    return data;
  } catch (err) {
    const duration = Date.now() - startTime;
    let errMsg = err.message;

    if (err.name === 'AbortError') {
      errMsg = `timeout ${timeoutMs}ms`;
    }

    // Gagal: catat ke SQLite + hukum provider di circuit breaker
    circuit.recordFailure(providerId);
    logger.error(`← ${providerId} · ${errMsg}`);

    _writeLog({
      provider:   providerId,
      model:      null,
      success:    false,
      latency_ms: duration,
      tokens_in:  null,
      tokens_out: null,
      effort:     effort || 'medium'
    });

    throw err;
  }
}

/**
 * Pipa Utama K-Router Engine: Mengatur distribusi cascade failover secara dinamis
 *
 * @param {string} backendUrl - Target URL Vercel
 * @param {Array}  messages   - Array of chat message objects [{role, content}]
 * @param {Object} [options={}] - Konfigurasi tambahan: { skipMemory, timeout, effort, provider }
 */
export async function sendChatRequest(backendUrl, messages, options = {}) {
  const state          = getState();
  const token          = state.token;
  const activeProvider = options.provider || state.activeProvider;
  const effort         = options.effort   || state.effort || 'medium';
  const timeoutMs      = options.timeout  || DEFAULT_TIMEOUT_MS;

  if (!token) {
    throw new Error('Akses ditolak: Token pendamping keamanan belum di-set.');
  }

  // Inject memory context ke system message (KECUALI mode agent ketat atau skipMemory=true)
  let enrichedMessages = messages;
  const shouldSkipMemory = options.skipMemory || _isStrictAgentPrompt(messages);

  if (!shouldSkipMemory) {
    try {
      const memCtx = await memory.buildMemoryContext(state.activeProject || null);
      if (memCtx) {
        const hasSystem = messages.length > 0 && messages[0].role === 'system';
        if (hasSystem) {
          enrichedMessages = [
            { role: 'system', content: messages[0].content + '\n\n' + memCtx },
            ...messages.slice(1)
          ];
        } else {
          enrichedMessages = [
            { role: 'system', content: memCtx },
            ...messages
          ];
        }
      }
    } catch (e) {
      logger.warn('Gagal inject memory context: ' + e.message);
      enrichedMessages = messages;
    }
  }

  // Skenario Jalur 1: User mengunci satu provider secara manual via /use
  if (activeProvider !== 'auto') {
    if (circuit.isTripped(activeProvider)) {
      logger.warn(`Provider "${activeProvider}" sedang diisolasi sirkuit. Membuka paksa kunci demi perintah user...`);
    }
    return await _executeTargetRequest(backendUrl, activeProvider, enrichedMessages, token, effort, timeoutMs);
  }

  // Skenario Jalur 2: Sistem "auto" — loop cascade otomatis
  const cascadeQueue = providers.getCascadeOrder(false);

  for (let i = 0; i < cascadeQueue.length; i++) {
    const target = cascadeQueue[i];

    if (circuit.isTripped(target.id)) {
      continue;
    }

    try {
      return await _executeTargetRequest(backendUrl, target.id, enrichedMessages, token, effort, timeoutMs);
    } catch (e) {
      if (i < cascadeQueue.length - 1) {
        const nextTarget = cascadeQueue[i + 1];
        logger.info(`→ ${nextTarget.id} · fallback cascade`);
      }
    }
  }

  // Skenario Jalur 3: Jalur utama habis, aktifkan rute darurat backup
  logger.warn('Seluruh pipa utama lumpuh. Mengaktifkan rute darurat backup redflag...');
  const backupQueue = providers.getCascadeOrder(true).filter(p => p.backup);

  for (let i = 0; i < backupQueue.length; i++) {
    const target = backupQueue[i];
    try {
      return await _executeTargetRequest(backendUrl, target.id, enrichedMessages, token, effort, timeoutMs);
    } catch (e) {
      // habiskan stok cadangan
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
      method:  'GET',
      headers: { 'Authorization': 'Bearer ' + getState().token }
    }, STATUS_TIMEOUT_MS);
    const duration = Date.now() - startTime;
    return res.ok ? duration : false;
  } catch (e) {
    return false;
  }
}
