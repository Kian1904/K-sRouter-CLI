#!/usr/bin/env node

/**
 * K-Router CLI Main Entry Point & REPL Engine
 * Location: /bin/cli.js
 * 
 * Jantung kendali utama antarmuka pengguna berbasis teks.
 * Mengintegrasikan ReAct Loop, HITL Interceptor, Diff Preview, dan Host Filesystem.
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Internal modules
import { getState, setState } from '../lib/state.js';
import * as auth      from '../lib/auth.js';
import * as circuit   from '../lib/circuit.js';
import * as logger    from '../lib/logger.js';
import * as providers from '../lib/providers.js';
import * as core      from '../lib/core.js';
import * as host      from '../lib/host.js';
import * as memory    from '../lib/memory.js';
import * as reactLoop from '../lib/react-loop.js';
import * as plan      from '../lib/plan.js';
import * as diff      from '../lib/diff.js';
import * as writer    from '../lib/writer.js';
import * as sync      from '../lib/sync.js';
import * as db        from '../lib/db.js';

const CONFIG_PATH = path.join(os.homedir(), '.krouter_config.json');

// Kunci Kode Warna ANSI Premium
const C_RESET   = '\x1b[0m';
const C_BOLD    = '\x1b[1m';
const C_RED     = '\x1b[31m';
const C_GREEN   = '\x1b[32m';
const C_YELLOW  = '\x1b[33m';
const C_BLUE    = '\x1b[34m';
const C_MAGENTA = '\x1b[35m';
const C_CYAN    = '\x1b[36m';
const C_MUTED   = '\x1b[90m';

let conversationHistory = [];
let rl = null;
let currentBackendUrl = process.env.KROUTER_BACKEND_URL || '';

// ── 1. Boot Initialization Protocol ─────────────────────────────────────────

async function boot() {
  console.clear();
  console.log(`${C_CYAN}${C_BOLD}=== K-ROUTER AUTONOMOUS CLI ENGINE v2026 ===${C_RESET}`);
  console.log(`${C_MUTED}Initializing ecosystem components...${C_RESET}\n`);

  logger.onLog((entry, formatted) => {
    console.log(formatted);
  });

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

  const hasToken = auth.hydrate();
  const hostSession = host.init();

  if (hostSession.hasSession) {
    logger.info(`Session file aktif: ${hostSession.activePath} (${hostSession.fileCount} file loaded)`);
  }

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

// ── 2. The Interactive REPL Loop & HITL Interceptor ────────────────────────

function _startReplLoop() {
  console.log(`\n${C_GREEN}K-Router CLI Siap Digunakan. Ketik ${C_BOLD}/help${C_RESET}${C_GREEN} untuk melihat menu commands.${C_RESET}\n`);
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // A. HITL Approval Interceptor — Tangkap input y/n/c atau /approve /reject /comment
    if (reactLoop.isPendingApproval()) {
      const lower = input.toLowerCase();
      if (lower === 'y' || lower === 'yes' || lower === '/approve') {
        reactLoop.resolveApproval('y');
      } else if (lower === 'n' || lower === 'no' || lower === '/reject') {
        reactLoop.resolveApproval('n');
      } else if (lower.startsWith('c ') || lower === 'c' || lower.startsWith('/comment ') || lower === '/comment') {
        const comment = lower.startsWith('/comment') ? input.slice(8).trim() : input.slice(1).trim();
        reactLoop.resolveApproval('c', comment);
      } else {
        console.log(`${C_YELLOW}[!] Waiting for approval. Ketik: y · /approve  |  n · /reject  |  c [teks] · /comment [teks]${C_RESET}`);
      }
      rl.prompt();
      return;
    }

    // B. Guard agar input chat tidak merusak agent yang sedang berjalan sibuk[span_14](start_span)[span_14](end_span)
    if (reactLoop.isRunning() && input !== '/exit' && input !== '/clear') {
      console.log(`${C_YELLOW}[!] Autonomous agent sedang eksekusi task. Tunggu sampai selesai atau minta persetujuan HITL.${C_RESET}`);
      rl.prompt();
      return;
    }

    // C. Advanced Command Parsing Layer
    if (input.startsWith('/')) {
      await _handleCommand(input);
    } else {
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
      console.log(`  ${C_CYAN}/task [deskripsi]${C_RESET}  - Menjalankan coding agent otonom (ReAct Loop + HITL)`);
      console.log(`  ${C_CYAN}/approve${C_RESET}           - Shortcut: approve HITL pending (sama dengan y)`);
      console.log(`  ${C_CYAN}/reject${C_RESET}            - Shortcut: reject HITL pending (sama dengan n)`);
      console.log(`  ${C_CYAN}/comment [teks]${C_RESET}   - Shortcut: revise dengan komentar (sama dengan c [teks])`);
      console.log(`  ${C_CYAN}/plan [deskripsi]${C_RESET}  - Generate & lihat preview execution plan JSON tanpa eksekusi`);
      console.log(`  ${C_CYAN}/diff [file]${C_RESET}       - Tampilkan unified diff antara cache memori vs file di disk`);
      console.log(`  ${C_CYAN}/help${C_RESET}              - Menampilkan panduan bantuan menu ini`);
      console.log(`  ${C_CYAN}/models${C_RESET}            - Memeriksa status kesehatan live seluruh provider AI`);
      console.log(`  ${C_CYAN}/use [alias]${C_RESET}      - Mengunci satu rute provider AI secara manual`);
      console.log(`  ${C_CYAN}/search [query]${C_RESET}    - Melakukan pencarian data real-time via Tavily`);
      console.log(`  ${C_CYAN}/dashboard${C_RESET}         - Menarik statistik penggunaan dari SQLite lokal`);
      console.log(`  ${C_CYAN}/sync${C_RESET}              - Sinkronisasi data lokal SQLite ke Supabase remote sekarang`);
      console.log(`  ${C_CYAN}/open [path]${C_RESET}      - Buka folder project, tampil struktur file`);
      console.log(`  ${C_CYAN}/ls [path]${C_RESET}        - List isi folder aktif`);
      console.log(`  ${C_CYAN}/read [file]${C_RESET}      - Baca file dan inject ke context AI`);
      console.log(`  ${C_CYAN}/context [clear]${C_RESET}  - Tampil session aktif / hapus file dari context`);
      console.log(`  ${C_CYAN}/memory${C_RESET}            - Kelola memory agent (setup, show, learn, decide)`);
      console.log(`  ${C_CYAN}/exit${C_RESET}              - Mematikan aplikasi secara aman\n`);
      break;

    case '/clear':
      console.clear();
      break;

    case '/exit':
      try {
        logger.info('Menyinkronkan data sebelum keluar...');
        await sync.syncOnExit();
      } catch (e) {
        logger.warn('Sync on exit gagal (data aman di lokal): ' + e.message);
      } finally {
        rl.close();
      }
      break;

    case '/task': {
      if (!args) {
        console.log(`${C_RED}Error: Deskripsi task tidak boleh kosong. Contoh: /task refactor fungsi validasi di utils.js${C_RESET}\n`);
        break;
      }
      if (reactLoop.isRunning()) {
        console.log(`${C_YELLOW}[!] Task lain sedang berjalan. Tunggu hingga selesai.${C_RESET}\n`);
        break;
      }
      // Mulai ReAct loop secara asinkron[span_15](start_span)[span_15](end_span)
      reactLoop.startTask(currentBackendUrl, args, (msg) => {
        console.log(msg);
        // Kalau agent pause nunggu HITL, munculin ulang REPL prompt biar lo tau bisa input y/n/c[span_16](start_span)[span_16](end_span)
        if (reactLoop.isPendingApproval() && rl) {
          rl.prompt();
        }
      });
      break;
    }

    case '/plan': {
      if (!args) {
        console.log(`${C_RED}Error: Deskripsi task tidak boleh kosong. Contoh: /plan tambahkan error handling di api.js${C_RESET}\n`);
        break;
      }
      console.log(`\n${C_CYAN}[→] Generating execution plan untuk: "${args}"...${C_RESET}`);
      const fileContext = host.buildContextString();
      const planRes = await plan.generatePlan(currentBackendUrl, args, fileContext);
      if (!planRes.ok) {
        console.log(`${C_RED}[✗] Gagal membuat plan: ${planRes.error}${C_RESET}\n`);
      } else {
        console.log(plan.formatPlan(planRes.plan));
      }
      break;
    }

    case '/diff': {
      if (!args) {
        console.log(`${C_RED}Error: Nama file wajib disertakan. Contoh: /diff app.js${C_RESET}\n`);
        break;
      }
      const cached = host.getFileContent(args);
      if (cached === null) {
        console.log(`${C_RED}Error: File "${args}" belum ada di context cache. Gunakan /read ${args} terlebih dahulu.${C_RESET}\n`);
        break;
      }
      try {
        const fullPath = host.resolvePath(args);
        if (!fs.existsSync(fullPath)) {
          console.log(`${C_YELLOW}File "${args}" belum ada di disk (file baru di cache).${C_RESET}\n`);
          break;
        }
        const diskContent = fs.readFileSync(fullPath, 'utf8');
        const diffRes = diff.generateDiff(args, cached, diskContent);
        console.log(diffRes.preview);
      } catch (e) {
        console.log(`${C_RED}Gagal membandingkan diff: ${e.message}${C_RESET}\n`);
      }
      break;
    }

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
      try {
        const stats = db.getUsageStats(7);
        console.log(`\n${C_BOLD}${C_MAGENTA}=== LOCAL USAGE STATS (7 hari terakhir) ===${C_RESET}`);
        console.log(`  Total requests  : ${stats.total}`);
        console.log(`  Success rate    : ${stats.success_rate}%`);
        if (stats.by_provider && stats.by_provider.length > 0) {
          console.log(`\n  ${C_BOLD}Per provider:${C_RESET}`);
          stats.by_provider.forEach(p => {
            console.log(`    ${p.provider.padEnd(16)} req: ${String(p.requests).padEnd(5)} ok: ${p.success_rate}%  avg: ${p.avg_latency_ms || '-'}ms`);
          });
        }
        console.log('');
      } catch (e) {
        logger.error(`Gagal membaca stats: ${e.message}`);
      }
      break;
    }

    case '/sync': {
      logger.info('Memulai sinkronisasi manual ke Supabase...');
      try {
        const result = await sync.syncNow();
        if (result && result.synced !== undefined) {
          console.log(`${C_GREEN}✓ Sync selesai — ${result.synced} records dikirim.${C_RESET}\n`);
        } else {
          console.log(`${C_GREEN}✓ Sync selesai.${C_RESET}\n`);
        }
      } catch (e) {
        logger.error(`Sync gagal: ${e.message}`);
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
                  rl.prompt();
                });
              });
            });
          });
        });
        return;
      }

      if (sub === 'learn') {
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

      if (sub === 'skip') {
        memory.recordSessionStart();
        console.log(`${C_MUTED}Memory setup dilewati. Ketik /memory setup kapanpun.${C_RESET}\n`);
        break;
      }

      console.log(`${C_YELLOW}Subcommand: show | setup | learn | decide | note | skip${C_RESET}\n`);
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
        host.clearContext();
        console.log(`${C_GREEN}Context cache berhasil dibersihkan.${C_RESET}\n`);
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

    case '/approve':
    case '/reject':
    case '/comment':
      console.log(`${C_YELLOW}[!] Tidak ada approval yang pending. Gunakan /task [deskripsi] untuk memulai task dulu.${C_RESET}\n`);
      break;

    default:
      console.log(`${C_RED}Command tidak dikenal. Ketik /help untuk melihat daftar perintah.${C_RESET}\n`);
  }
}

// ── 4. Remote Chat Connection Handler ──────────────────────────────────────

async function _handleChatInput(text) {
  const stale = host.checkFingerprints();
  if (stale.length > 0) {
    stale.forEach(s => {
      console.log(`${C_YELLOW}⚠ ${s.filename} telah ${s.reason} sejak terakhir dimuat. Reload dengan /read ${s.filename}${C_RESET}`);
    });
  }

  const contextStr = host.buildContextString();
  const messageToSend = contextStr ? text + '\n\n' + contextStr : text;

  conversationHistory.push({ role: 'user', content: messageToSend });

  logger.info('Mempersiapkan rute koordinasi pipa AI...');
  
  try {
    const result = await core.sendChatRequest(currentBackendUrl, conversationHistory);
    
    if (result && result.choices && result.choices[0] && result.choices[0].message) {
      const aiResponse = result.choices[0].message;
      
      console.log(`\n${C_CYAN}${C_BOLD}AI Response:${C_RESET}`);
      console.log(`${aiResponse.content}\n`);
      
      conversationHistory.push({ role: 'assistant', content: aiResponse.content });
    } else {
      throw new Error('Format balasan data JSON dari remote server tidak valid.');
    }
  } catch (err) {
    logger.error(`Gagal memproses instruksi obrolan: ${err.message}`);
    conversationHistory.pop();
  }
}

boot();

