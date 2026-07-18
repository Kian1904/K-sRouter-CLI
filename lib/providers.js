/**
 * K-Router CLI Provider Registry & Route Resolver
 * Location: /lib/providers.js
 * 
 * Bertindak sebagai replika lokal dari api/_providers.js untuk kebutuhan CLI.
 * Mengelola kecocokan alias perintah /use dan urutan distribusi cascade failover.
 */

// Registrasi Data Teknis Seluruh Provider AI Resmi K-Router
export const PROVIDERS = {
  groq: {
    id: 'groq', name: 'Groq · Llama 3.3 70B',
    model: 'llama-3.3-70b-versatile', priority: 1, backup: false
  },
  google_gemini: {
    id: 'google_gemini', name: 'Google · Gemini 2.5 Flash',
    model: 'gemini-2.5-flash', priority: 2, backup: false
  },
  nvidia_z_ai: {
    id: 'nvidia_z_ai', name: 'NVIDIA NIM · GLM 5.2',
    model: 'z-ai/glm-5.2', priority: 3, backup: false
  },
  cerebras: {
    id: 'cerebras', name: 'Cerebras · Gemma 4 31B',
    model: 'google/gemma-4-31B-it', priority: 4, backup: false
  },
  cohere_north: {
    id: 'cohere_north', name: 'Cohere · North Mini Code',
    model: 'cohere/north-mini-code:free', priority: 5, backup: false
  },
  mistral: {
    id: 'mistral', name: 'Mistral · Codestral',
    model: 'codestral-latest', priority: 6, backup: false
  },
  laguna_xs: {
    id: 'laguna_xs', name: 'Poolside · Laguna XS 2.1',
    model: 'poolside/laguna-xs-2.1:free', priority: 7, backup: true
  },
  laguna_m1: {
    id: 'laguna_m1', name: 'Poolside · Laguna M.1',
    model: 'poolside/laguna-m.1:free', priority: 8, backup: true
  }
}; //

// Kamus Pintar Pemetaan Kata Kunci Alias untuk Perintah /use[cite: 7]
export const MODEL_ALIASES = {
  'auto':       null,
  'groq':       'groq',
  'llama':      'groq',
  'gemini':     'google_gemini',
  'glm':        'nvidia_z_ai',
  'nvidia':     'nvidia_z_ai',
  'gemma':      'cerebras',
  'cerebras':   'cerebras',
  'cohere':     'cohere_north',
  'north':      'cohere_north',
  'codestral':  'mistral',
  'mistral':    'mistral',
  'laguna_xs':  'laguna_xs',
  'laguna_m1':  'laguna_m1'
}; //[cite: 7]

/**
 * Mengubah input mentah user menjadi ID Provider resmi[cite: 7]
 * Mendukung deteksi partial match cerdas (misal ngetik "/use codest" tetap mendeteksi mistral)[cite: 7]
 */
export function resolveAlias(input) {
  // Proteksi pembersihan string mutlak sesuai konvensi utama
  const key = input.toLowerCase().trim().replace(/-/g, '_'); //[cite: 7]

  // Jalur 1: Deteksi kecocokan absolut pada kamus alias[cite: 7]
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, key)) {
    return { id: MODEL_ALIASES[key], ambiguous: false }; //[cite: 7]
  }

  // Jalur 2: Deteksi jika user langsung mengetikkan ID Provider asli[cite: 7]
  if (PROVIDERS[key]) {
    return { id: key, ambiguous: false }; //[cite: 7]
  }

  // Jalur 3: Deteksi partial/kemiripan string secara dinamis[cite: 7]
  const matches = Object.keys(MODEL_ALIASES).filter(alias => alias.indexOf(key) === 0); //[cite: 7]

  if (matches.length === 1) {
    return { id: MODEL_ALIASES[matches[0]], ambiguous: false }; //[cite: 7]
  }
  
  // Jika ditemukan lebih dari satu kemiripan alias (Ambiguitas rute)[cite: 7]
  if (matches.length > 1) {
    return { ambiguous: true, options: matches }; //[cite: 7]
  }

  return null; //[cite: 7]
}

/**
 * Mengambil susunan pipa distribusi AI berdasarkan urutan prioritas sakral[cite: 7]
 */
export function getCascadeOrder(includeBackup) {
  return Object.values(PROVIDERS)
    .filter(p => includeBackup || !p.backup) //[cite: 7]
    .sort((a, b) => a.priority - b.priority); //[cite: 7]
}

/**
 * Mengambil detail metadata teknis dari satu provider spesifik[cite: 7]
 */
export function getProvider(id) {
  return PROVIDERS[id] || null; //[cite: 7]
}