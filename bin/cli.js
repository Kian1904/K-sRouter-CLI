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
import * as host from '../lib/host.js';
import * as memory from '../lib/memory.js';

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

  // Init host session (resume session terakhir kalau ada)
  const hostSession = host.init();
  if (hostSession.hasSession) {
    logger.info(`Session file aktif: ${hostSession.activePath} (${hostSession.fileCount} file loaded)`);
  }

  // Memory system init
  if (memory.isFirstBoot()) {
    console.log(`\n${C_YELLOW}╔════════════════════════════════════════╗`);
    console.log(`║     FIRST BOOT — Memory Setup          ║`);
    console.log(`╚════════════════════════════════════════╝${C_RESET}`);
    console.log(`${C_MUTED}Agent perlu mengenalmu. Ketik /memory setup untuk mulai.${C_RESET}\n`);
  } else {
    const sessionCtx = memory.recordSessionStart();
    if (sessionCtx.isLate) {
      console.log(`${C_YELLOW}⚠ Late session (${sessionCtx.currentTime}). Jaga kesehatan ya.${C_RESET}\n`);
    }
  }

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
        logger.ok('Token terverifikasi mutlak. Gerbang akses dibuka.');
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
    if (input.startsWith('/')) {
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
  const command = parts[0].toLowerCase().trim();
  const args = parts.slice(1).join(' ').trim();

  switch (command) {
    case '/help':
      console.log(`\n${C_BOLD}Daftar Perintah Resmi K-Router CLI:${C_RESET}`);
      console.log(`  ${C_CYAN}/help${C_RESET}            - Menampilkan panduan bantuan menu ini`);
      console.log(`  ${C_CYAN}/models${C_RESET}          - Memeriksa status kesehatan live seluruh provider AI`);
      console.log(`  ${C_CYAN}/use [alias]${C_RESET}    - Mengunci satu rute provider AI secara manual`);
      console.log(`  ${C_CYAN}/search [query]${C_RESET}  - Melakukan pencarian data real-time via Tavily`);
      console.log(`  ${C_CYAN}/dashboard${C_RESET}       - Menarik statistik penggunaan dari data Supabase`);
      console.log(`  ${C_CYAN}/open [path]${C_RESET}    - Buka folder project, tampil struktur file`);
      console.log(`  ${C_CYAN}/ls${C_RESET}              - List isi folder aktif`);
      console.log(`  ${C_CYAN}/read [file]${C_RESET}    - Baca file dan inject ke context AI`);
      console.log(`  ${C_CYAN}/context${C_RESET}         - Tampil session aktif dan file yang dimuat`);
      console.log(`  ${C_CYAN}/memory${C_RESET}          - Kelola memory agent (setup, show, learn, decide)`);
      console.log(`  ${C_CYAN}/exit${C_RESET}            - Mematikan aplikasi secara aman\n`);
      break;

    case '/clear':
      console.clear();
      break;

    case '/exit':
      rl.close();
      break;

    case '/use': {
      if (!args) {
        console.log(`${C_RED}Error: Parameter alias wajib disertakan. Contoh: /use gemini${C_RESET}\n`);
        break;
      }
      const result = providers.resolveAlias(args);
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
          setState({ activeProvider: targetId }, { caller: 'cli.cmdUse' });
          logger.info(`Rute AI berhasil dikunci penuh ke provider: ${targetId}`);
        }
      }
      break;
    }

    case '/models': {
      logger.info('Memulai pemindaian HTTP ping kesehatan infrastruktur...');
      const latency = await core.checkServerStatus(currentBackendUrl);
      if (latency === false) {
        console.log(`${C_RED}Status Backend: DOWN / UNREACHABLE${C_RESET}\n`);
      } else {
        console.log(`\n${C_GREEN}Status Backend Vercel: LIVE (${latency}ms)${C_RESET}`);
        console.log(`${C_BOLD}Daftar Rute Distribusi Pipa Cascade:${C_RESET}`);
        const list = providers.getCascadeOrder(true);
        const cStatus = circuit.getStatus();
        
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

    case '/search': {
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

    case '/dashboard': {
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

    case '/memory': {
      const sub = args.split(' ')[0];
      const rest = args.slice(sub.length).trim();

      if (!sub || sub === 'show') {
        const personal  = memory.getPersonal();
        const emotional = memory.getEmotional();
        console.log(`\n${C_BOLD}Personal Memory:${C_RESET}`);
        console.log(`  Nickname  : ${personal.nickname || '(belum diset)'}`);
        console.log(`  Stack     : ${(personal.stack || []).join(', ') || '(kosong)'}`);
        console.log(`  Work hours: ${personal.work_hours ? personal.work_hours.start + ' - ' + personal.work_hours.end : '-'}`);
        console.log(`  Late after: ${emotional.late_threshold || '00:00'}`);
        console.log(`  Sessions  : ${emotional.session_count || 0}`);
        console.log(`  Avg session: ${emotional.avg_session_min || 0} min\n`);
        break;
      }

      if (sub === 'setup') {
        console.log(`\n${C_GREEN}Memory Setup — jawab beberapa pertanyaan:${C_RESET}\n`);
        rl.question(`  Nama panggilan lo: `, (nickname) => {
          rl.question(`  Tech stack lo (pisah koma): `, (stackStr) => {
            rl.question(`  Jam mulai kerja (HH:MM): `, (workStart) => {
              rl.question(`  Jam selesai kerja (HH:MM): `, (workEnd) => {
                rl.question(`  Jam berapa dianggap "late session" (HH:MM, default 00:00): `, (late) => {
                  const stack = stackStr.split(',').map(s => s.trim()).filter(Boolean);
                  memory.savePersonal({
                    nickname:   nickname.trim() || null,
                    stack:      stack,
                    work_hours: { start: workStart.trim() || '09:00', end: workEnd.trim() || '23:00' }
                  });
                  memory.setLateThreshold(late.trim() || '00:00');
                  memory.recordSessionStart();
                  console.log(`\n${C_GREEN}✓ Memory tersimpan. Agent sekarang mengenalmu.${C_RESET}\n`);
                  _prompt();
                });
              });
            });
          });
        });
        return; // jangan prompt lagi sebelum wizard selesai
      }

      if (sub === 'learn') {
        // /memory learn [error] | [solution]
        const parts = rest.split('|');
        if (parts.length < 2) {
          console.log(`${C_YELLOW}Usage: /memory learn [error summary] | [solution]${C_RESET}\n`);
          break;
        }
        await memory.saveLearning(parts[0].trim(), parts[1].trim(), null, 90);
        console.log(`${C_GREEN}✓ Learning disimpan ke Supabase.${C_RESET}\n`);
        break;
      }

      if (sub === 'decide') {
        // /memory decide [decision] | [reason]
        const parts = rest.split('|');
        if (parts.length < 2) {
          console.log(`${C_YELLOW}Usage: /memory decide [decision] | [reason]${C_RESET}\n`);
          break;
        }
        await memory.saveDecision(null, parts[0].trim(), parts[1].trim(), null);
        console.log(`${C_GREEN}✓ Decision disimpan ke Supabase.${C_RESET}\n`);
        break;
      }

      if (sub === 'note') {
        if (!rest) {
          console.log(`${C_YELLOW}Usage: /memory note [catatan tentang kamu]${C_RESET}\n`);
          break;
        }
        memory.addPersonalityNote(rest);
        console.log(`${C_GREEN}✓ Note ditambahkan ke personal memory.${C_RESET}\n`);
        break;
      }

      if (sub === 'purge') {

  console.log(`${C_RED}WARNING!${C_RESET}`);
  console.log("Semua memory lokal dan Supabase akan dihapus.");
  console.log("");

  rl.question("Ketik YES untuk melanjutkan: ", async(answer) => {

    if(answer !== "YES"){

      console.log("Dibatalkan.\n");

      _prompt();

      return;

    }

    try{

      await memory.purgeAllMemory();

      console.log(`${C_GREEN}✓ Semua memory berhasil dihapus.${C_RESET}\n`);

    }catch(err){

      console.log(`${C_RED}Gagal menghapus memory:${C_RESET}`,err.message);

    }

    _prompt();

  });

  return;

      }

      if (sub === 'skip') {
        memory.recordSessionStart();
        console.log(`${C_MUTED}Memory setup dilewati. Ketik /memory setup kapanpun.${C_RESET}\n`);
        break;
      }

      console.log(`${C_YELLOW}Subcommand: show | setup | learn | decide | note | skip | purge${C_RESET}\n`);
      break;
    }

    case '/effort': {
      const valid = ['low', 'medium', 'high'];
      if (!args || !valid.includes(args.toLowerCase())) {
        console.log(`${C_YELLOW}Usage: /effort [low|medium|high]${C_RESET}\n`);
        break;
      }
      setState({ effort: args.toLowerCase() }, { caller: 'cli.cmdEffort' });
      console.log(`${C_GREEN}Effort dikunci ke: ${args.toLowerCase()}${C_RESET}\n`);
      break;
    }

    case '/open': {
      const result = host.openPath(args);
      if (!result.ok) {
        console.log(`${C_RED}Error: ${result.error}${C_RESET}\n`);
        break;
      }
      console.log(`\n${C_GREEN}Opened: ${result.activePath}${C_RESET}`);
      if (result.entries && result.entries.length > 0) {
        console.log(`${C_BOLD}\nContents:${C_RESET}`);
        result.entries.forEach(e => {
          if (e.type === 'dir') {
            console.log(`  ${C_CYAN}[dir]${C_RESET}  ${e.name}`);
          } else {
            const tag = e.readable ? '' : ` ${C_RED}(too large)${C_RESET}`;
            console.log(`  ${C_MUTED}[file]${C_RESET} ${e.name} ${C_MUTED}${e.size}${C_RESET}${tag}`);
          }
        });
      } else {
        console.log(`${C_MUTED}(folder kosong atau tidak ada file yang didukung)${C_RESET}`);
      }
      console.log('');
      break;
    }

    case '/ls': {
      const result = host.listCurrent(args || null);
      if (!result.ok) {
        console.log(`${C_RED}Error: ${result.error}${C_RESET}\n`);
        break;
      }
      console.log(`\n${C_BOLD}${result.activePath}${C_RESET}`);
      result.entries.forEach(e => {
        if (e.type === 'dir') {
          console.log(`  ${C_CYAN}[dir]${C_RESET}  ${e.name}`);
        } else {
          const tag = e.readable ? '' : ` ${C_RED}(too large)${C_RESET}`;
          console.log(`  ${C_MUTED}[file]${C_RESET} ${e.name} ${C_MUTED}${e.size}${C_RESET}${tag}`);
        }
      });
      console.log('');
      break;
    }

    case '/read': {
      if (!args) {
        console.log(`${C_RED}Error: Nama file wajib disertakan. Contoh: /read app.js${C_RESET}\n`);
        break;
      }
      const result = host.readFile(args);
      if (!result.ok) {
        console.log(`${C_RED}Error: ${result.error}${C_RESET}\n`);
        break;
      }
      if (result.changed) {
        console.log(`${C_YELLOW}⚠ File berubah sejak terakhir dibaca — versi baru dimuat.${C_RESET}`);
      }
      console.log(`${C_GREEN}✓ ${result.filename} dimuat (${result.size})${C_RESET}`);
      if (result.overLimit) {
        console.log(`${C_YELLOW}⚠ Total context melebihi 200KB (${result.totalContext}). Beberapa provider mungkin memotong response.${C_RESET}`);
      } else {
        console.log(`${C_MUTED}  Total context: ${result.totalContext}${C_RESET}`);
      }
      console.log('');
      break;
    }

    case '/context': {
      if (args === 'clear') {
        // Clear loaded files from session
        const ctx = host.getContext();
        console.log(`${C_GREEN}Context cleared.${C_RESET}\n`);
        break;
      }
      const result = host.getContext();
      if (!result.activePath) {
        console.log(`${C_MUTED}Belum ada session aktif. Gunakan /open [path]${C_RESET}\n`);
        break;
      }
      console.log(`\n${C_BOLD}Session aktif:${C_RESET} ${result.activePath}`);
      console.log(`${C_BOLD}Total context:${C_RESET} ${result.totalContext}${result.overLimit ? ` ${C_YELLOW}(over limit)${C_RESET}` : ''}`);
      if (result.files.length === 0) {
        console.log(`${C_MUTED}Belum ada file yang dimuat. Gunakan /read [filename].${C_RESET}`);
      } else {
        console.log(`${C_BOLD}\nFile loaded:${C_RESET}`);
        result.files.forEach(f => {
          console.log(`  ${C_GREEN}✓${C_RESET} ${f.filename} ${C_MUTED}(${f.size} · ${f.fingerprint})${C_RESET}`);
        });
      }
      console.log('');
      break;
    }

    default:
      console.log(`${C_RED}Command tidak dikenal. Ketik /help untuk melihat daftar rute perintah.${C_RESET}\n`);
  }
}

// ── 4. Remote Chat Connection Handler ──────────────────────────────────────

async function _handleChatInput(text) {
  // Cek fingerprint — detect file yang berubah di luar CLI
  const stale = host.checkFingerprints();
  if (stale.length > 0) {
    stale.forEach(s => {
      console.log(`${C_YELLOW}⚠ ${s.filename} telah ${s.reason} sejak terakhir dimuat. Reload dengan /read ${s.filename}${C_RESET}`);
    });
  }

  // Inject file context kalau ada
  const contextStr = host.buildContextString();
  const messageToSend = contextStr ? text + '\n\n' + contextStr : text;

  // Masukkan pesan user ke memori lokal sesi saat ini
  conversationHistory.push({ role: 'user', content: messageToSend });

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
