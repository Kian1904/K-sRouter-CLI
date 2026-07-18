#!/usr/bin/env node

/**
 * K-Router CLI Main Entry Point & REPL Engine
 * Location: /bin/cli.js
 * 
 * Jantung kendali utama antarmuka pengguna berbasis teks.
 * Mengelola interaksi asinkron tanpa hambatan keyboard (Anti-Stuttering).
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Impor seluruh pustaka internal K-Router yang sudah kita bangun
import { getState, setState } from '../lib/state.js';
import * as auth from '../lib/auth.js';
import * as circuit from '../lib/circuit.js';
import * as logger from '../lib/logger.js';
import * as providers from '../lib/providers.js';
import * as core from '../lib/core.js';

const CONFIG_PATH = path.join(os.homedir(), '.krouter_config.json');

// Kunci Kode Warna ANSI Premium (Minimalist-UI Terjemahan Terminal)
const C_RESET   = '\x1b[0m';
const C_BOLD    = '\x1b[1m';
const C_RED     = '\x1b[31m';
const C_GREEN   = '\x1b[32m';
const C_YELLOW  = '\x1b[33m';
const C_BLUE    = '\x1b[34m';
const C_MAGENTA = '\x1b[35m';
const C_CYAN    = '\x1b[36m';
const C_MUTED   = '\x1b[90m'; // Off-white/Gray text style

// Memori Percakapan Sementara Sesi Ini
let conversationHistory = [];
let rl = null;
let currentBackendUrl = process.env.KROUTER_BACKEND_URL || '';

// ── 1. Boot Initialization Protocol ─────────────────────────────────────────

async function boot() {
  console.clear();
  console.log(`${C_CYAN}${C_BOLD}=== K-ROUTER AUTONOMOUS CLI ENGINE v2026 ===${C_RESET}`);
  console.log(`${C_MUTED}Initializing ecosystem components...${C_RESET}\n`);

  // Sambungkan kabel subscriber dari logger ke terminal display output
  logger.onLog((entry, formatted) => {
    console.log(formatted);
  });

  // Load konfigurasi tambahan (Backend URL) dari file lokal rahasia
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.backend_url) currentBackendUrl = cfg.backend_url;
    } catch (_) {}
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C_GREEN}${C_BOLD}k-router> ${C_RESET}`
  });

  // Jalankan First Boot Hydration Protocol untuk Token
  const hasToken = auth.hydrate();

  if (!currentBackendUrl) {
    rl.question(`${C_YELLOW}Masukkan Absolute Target URL Vercel Backend Lo:${C_RESET} `, (url) => {
      currentBackendUrl = url.trim();
      _saveBackendConfig();
      _checkTokenSetup(hasToken);
    });
  } else {
    _checkTokenSetup(hasToken);
  }
}

function _saveBackendConfig() {
  try {
    let currentConfig = {};
    if (fs.existsSync(CONFIG_PATH)) {
      currentConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    currentConfig.backend_url = currentBackendUrl;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');
  } catch (e) {
    logger.error(`Gagal mengamankan data URL backend: ${e.message}`);
  }
}

function _checkTokenSetup(hasToken) {
  if (!hasToken) {
    rl.question(`${C_YELLOW}Akses Pertama Ditemukan. Masukkan BEARER_TOKEN Anda:${C_RESET} `, async (token) => {
      const cleanToken = token.trim();
      logger.info('Melakukan verifikasi token keamanan ke remote server...');
      
      const isValid = await auth.verifyToken(cleanToken, currentBackendUrl);
      if (isValid) {
        auth.saveToken(cleanToken);
        logger.ok('Token terverifikasi mutlak. Gerbang akses dibuka.');[cite: 1]
        _startReplLoop();
      } else {
        logger.error('Verifikasi token ditolak oleh Vercel (411/401 Unauthorized).');
        process.exit(1);
      }
    });
  } else {
    logger.info(`Token terdeteksi di storage. Menghubungkan ke: ${currentBackendUrl}`);
    _startReplLoop();
  }
}

// ── 2. The Interactive REPL Loop ───────────────────────────────────────────

function _startReplLoop() {
  console.log(`\n${C_GREEN}K-Router CLI Siap Digunakan. Ketik ${C_BOLD}/help${C_RESET}${C_GREEN} untuk melihat menu commands.${C_RESET}\n`);
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Advanced Command Parsing Layer
    if (input.startsWith('/')) {[cite: 1]
      await _handleCommand(input);
    } else {
      // Input teks biasa: Kirim langsung sebagai instruksi chat AI
      await _handleChatInput(input);
    }
    rl.prompt();
  }).on('close', () => {
    console.log(`\n${C_CYAN}Exiting K-Router safely. See you space cowboy...${C_RESET}\n`);
    process.exit(0);
  });
}

// ── 3. Advanced Slash Command Parser Engine ────────────────────────────────

async function _handleCommand(rawInput) {
  const parts = rawInput.split(' ');
  const command = parts[0].toLowerCase().trim();[cite: 1]
  const args = parts.slice(1).join(' ').trim();

  switch (command) {
    case '/help':[cite: 1]
      console.log(`\n${C_BOLD}Daftar Perintah Resmi K-Router CLI:${C_RESET}`);
      console.log(`  ${C_CYAN}/help${C_RESET}           - Menampilkan panduan bantuan menu ini`);
      console.log(`  ${C_CYAN}/models${C_RESET}         - Memeriksa status kesehatan live seluruh provider AI`);
      console.log(`  ${C_CYAN}/use [alias]${C_RESET}   - Mengunci satu rute provider AI secara manual`);
      console.log(`  ${C_CYAN}/search [query]${C_RESET} - Melakukan pencarian data real-time via Tavily`);
      console.log(`  ${C_CYAN}/dashboard${C_RESET}      - Menarik statistik penggunaan dari data Supabase[cite: 1]`);
      console.log(`  ${C_CYAN}/clear${C_RESET}          - Membersihkan riwayat layar monitor terminal[cite: 1]`);
      console.log(`  ${C_CYAN}/exit${C_RESET}           - Mematikan aplikasi secara aman\n`);
      break;

    case '/clear':[cite: 1]
      console.clear();
      break;

    case '/exit':
      rl.close();
      break;

    case '/use': {[cite: 1]
      if (!args) {
        console.log(`${C_RED}Error: Parameter alias wajib disertakan. Contoh: /use gemini${C_RESET}\n`);
        break;
      }
      const result = providers.resolveAlias(args);[cite: 1]
      if (!result) {
        console.log(`${C_RED}Error: Alias model "${args}" tidak dikenali sistem.${C_RESET}\n`);
      } else if (result.ambiguous) {
        console.log(`${C_YELLOW}Alias ambigu. Pilihan alternatif: ${result.options.join(', ')}${C_RESET}\n`);
      } else {
        const targetId = result.id;
        if (targetId === null) {
          setState({ activeProvider: 'auto' }, { caller: 'cli.cmdUse' });
          logger.info('Mode rute dikembalikan ke deteksi otomatis (Cascade Auto-Router).');
        } else {
          setState({ activeProvider: targetId }, { caller: 'cli.cmdUse' });[cite: 1]
          logger.info(`Rute AI berhasil dikunci penuh ke provider: ${targetId}`);
        }
      }
      break;
    }

    case '/models': {[cite: 1]
      logger.info('Memulai pemindaian HTTP ping kesehatan infrastruktur...');
      const latency = await core.checkServerStatus(currentBackendUrl);
      if (latency === false) {
        console.log(`${C_RED}Status Backend: DOWN / UNREACHABLE${C_RESET}\n`);
      } else {
        console.log(`\n${C_GREEN}Status Backend Vercel: LIVE (${latency}ms)${C_RESET}`);
        console.log(`${C_BOLD}Daftar Rute Distribusi Pipa Cascade:${C_RESET}`);
        const list = providers.getCascadeOrder(true);[cite: 1]
        const cStatus = circuit.getStatus();[cite: 1]
        
        list.forEach(p => {
          const stats = cStatus[p.id] || { failures: 0, tripped: false };
          const statusText = stats.tripped 
            ? `${C_RED}[TRIPPED - ISOLATED]${C_RESET}` 
            : `${C_GREEN}[HEALTHY]${C_RESET}`;
          const typeBadge = p.backup ? `${C_RED}(Backup)${C_RESET}` : `${C_CYAN}(Core)${C_RESET}`;
          console.log(`  • ${C_BOLD}${p.id.padEnd(15)}${C_RESET} ${typeBadge} -> Failures: ${stats.failures}/5 | ${statusText}`);
        });
        console.log('');
      }
      break;
    }

    case '/search': {[cite: 1]
      if (!args) {
        console.log(`${C_RED}Error: Kueri pencarian tidak boleh kosong!${C_RESET}\n`);
        break;
      }
      logger.info(`Mengirim kueri pencarian internet riil via Tavily: "${args}"...`);
      try {
        const res = await fetch(`${currentBackendUrl.replace(/\/$/, '')}/api/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getState().token}` },
          body: JSON.stringify({ query: args })
        });
        const data = await res.json();
        console.log(`\n${C_BOLD}${C_GREEN}=== HASIL PENCARIAN WEB INTERNET ===${C_RESET}\n`, JSON.stringify(data, null, 2), '\n');
      } catch (e) {
        logger.error(`Operasi pencarian gagal dieksekusi: ${e.message}`);
      }
      break;
    }

    case '/dashboard': {[cite: 1]
      logger.info('Menarik data logs analitik penggunaan dari Supabase...');
      try {
        const res = await fetch(`${currentBackendUrl.replace(/\/$/, '')}/api/log`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${getState().token}` }
        });
        const data = await res.json();
        console.log(`\n${C_BOLD}${C_MAGENTA}=== SUPABASE STATS DASHBOARD ===${C_RESET}\n`, JSON.stringify(data, null, 2), '\n');
      } catch (e) {
        logger.error(`Gagal memuat log analitik dari Supabase: ${e.message}`);
      }
      break;
    }

    default:
      console.log(`${C_RED}Command tidak dikenal. Ketik /help untuk melihat daftar rute perintah.${C_RESET}\n`);
  }
}

// ── 4. Remote Chat Connection Handler ──────────────────────────────────────

async function _handleChatInput(text) {
  // Masukkan pesan user ke memori lokal sesi saat ini[cite: 1]
  conversationHistory.push({ role: 'user', content: text });

  logger.info('Mempersiapkan rute koordinasi pipa AI...');
  
  try {
    const result = await core.sendChatRequest(currentBackendUrl, conversationHistory);
    
    if (result && result.choices && result.choices[0] && result.choices[0].message) {
      const aiResponse = result.choices[0].message;
      
      // Tampilkan respons jawaban AI ke terminal dengan format kontras tinggi
      console.log(`\n${C_CYAN}${C_BOLD}AI Response:${C_RESET}`);
      console.log(`${aiResponse.content}\n`);
      
      // Amankan jawaban AI ke dalam riwayat context memori jangka pendek sesi ini
      conversationHistory.push({ role: 'assistant', content: aiResponse.content });
    } else {
      throw new Error('Format balasan data JSON dari remote server tidak valid.');
    }
  } catch (err) {
    logger.error(`Gagal memproses instruksi obrolan: ${err.message}`);
    // Jika eror total melanda, potong input terakhir dari memori agar sinkronisasi context aman
    conversationHistory.pop();
  }
}

// Menghidupkan siklus hidup aplikasi CLI secara riil
boot();
