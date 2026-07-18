/**
 * K-Router CLI Token Encryptor & Home Directory Guard
 * Location: /lib/auth.js
 * 
 * Mengamankan token Bearer secara lokal di folder home pengguna OS (~/.krouter_config.json).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { setState } from './state.js';

const XOR_KEY = 'KsRouter2026';
// Menyimpan file config secara tersembunyi di root user directory (~/.krouter_config.json)
const CONFIG_PATH = path.join(os.homedir(), '.krouter_config.json');

// ── 1. XOR + Buffer Obfuscation (Node.js Native Replacement) ────────────────

function _obfuscate(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(
      str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
    );
  }
  // Mengganti btoa() browser dengan standard Node.js Buffer
  return Buffer.from(out, 'binary').toString('base64');
}

function _deobfuscate(encoded) {
  // Mengganti atob() browser dengan standard Node.js Buffer
  const str = Buffer.from(encoded, 'base64').toString('binary');
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(
      str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
    );
  }
  return out;
}

// ── 2. Node.js File System Storage Operations ──────────────────────────────

export function loadToken() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const rawData = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(rawData);
    if (!config.kr_t) return null;
    return _deobfuscate(config.kr_t);
  } catch (e) {
    console.error(`\x1b[31m[AUTH ERROR] Gagal membaca config file: ${e.message}\x1b[0m`);
    return null;
  }
}

export function saveToken(token) {
  try {
    const payload = { kr_t: _obfuscate(token) };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
    setState({ token: token }, { caller: 'auth.saveToken' });
  } catch (e) {
    console.error(`\x1b[31m[AUTH ERROR] Gagal menulis token ke storage lokal: ${e.message}\x1b[0m`);
  }
}

export function clearToken() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH); // Hapus file fisik config di HP/PC
    }
    setState({ token: null }, { caller: 'auth.clearToken' });
  } catch (e) {
    console.error(`\x1b[31m[AUTH ERROR] Gagal menghapus file config: ${e.message}\x1b[0m`);
  }
}

// ── 3. Absolute Remote API Token Verification ─────────────────────────────

export async function verifyToken(token, backendUrl) {
  // Karena CLI bersifat remote target, kita wajib menembak ABSOLUTE URL Vercel lo
  const targetUrl = `${backendUrl.replace(/\/$/, '')}/api/chat`;
  
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] })
    });
    return res.status !== 401;
  } catch (err) {
    // Jika offline / network error, loloskan secara natural agar ditangani engine utama
    return true; 
  }
}

// ── 4. First Boot Hydration Protocol ────────────────────────────────────────

export function hydrate() {
  const token = loadToken();
  if (token) {
    setState({ token: token }, { caller: 'auth.hydrate' });
    return true;
  }
  return false;
}