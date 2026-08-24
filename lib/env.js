import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({
  path: path.join(projectRoot, '.env')
});

export function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} env var not set`)
  }
  return value;
}