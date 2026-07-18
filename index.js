/**
 * K-Router SDK Library Wrapper
 * Location: /index.js
 * 
 * Mengekspos fungsi internal krouter agar bisa di-import oleh aplikasi lain.
 */

import { setState, getState } from './lib/state.js';
import * as authModule from './lib/auth.js';
import * as coreModule from './lib/core.js';
import * as providersModule from './lib/providers.js';

// Ambil URL default dari env atau set default lokal
const BACKEND_URL = process.env.KROUTER_BACKEND_URL || 'https://domain-vercel-lo.vercel.app';

/**
 * 1. Fungsi Auth SDK
 */
export async function auth(token) {
  const cleanToken = token.trim();
  const isValid = await authModule.verifyToken(cleanToken, BACKEND_URL);
  if (!isValid) throw new Error('Authentication Failed: Token rejected by server.');
  authModule.saveToken(cleanToken);
  return true;
}

/**
 * 2. Fungsi Pipa Chat SDK
 */
export async function chat(messages) {
  return await coreModule.sendChatRequest(BACKEND_URL, messages);
}

/**
 * 3. Fungsi Kunci Rute AI SDK
 */
export function use(alias) {
  const result = providersModule.resolveAlias(alias);
  if (!result || result.ambiguous) {
    throw new Error(`Invalid or ambiguous provider alias: ${alias}`);
  }
  const targetId = result.id || 'auto';
  setState({ activeProvider: targetId }, { caller: 'sdk.use' });
}

/**
 * 4. Fungsi Status Ping SDK
 */
export async function status() {
  const latency = await coreModule.checkServerStatus(BACKEND_URL);
  if (latency === false) throw new Error('Backend server is unreachable.');
  return latency;
}