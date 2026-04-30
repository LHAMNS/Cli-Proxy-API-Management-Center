import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CliConfig {
  apiBase?: string;
  managementKey?: string;
  defaultProjectId?: string;
}

const DEFAULT_API_BASE = 'http://localhost:8317';

const resolveConfigPath = (): string => {
  if (process.env.CPA_CONFIG?.trim()) return process.env.CPA_CONFIG.trim();
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'cpa', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'cpa', 'config.json');
};

export const CONFIG_PATH = resolveConfigPath();

export async function loadCliConfig(): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const cfg: CliConfig = {};
    if (typeof record.apiBase === 'string') cfg.apiBase = record.apiBase;
    if (typeof record.managementKey === 'string') cfg.managementKey = record.managementKey;
    if (typeof record.defaultProjectId === 'string') cfg.defaultProjectId = record.defaultProjectId;
    return cfg;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveCliConfig(partial: Partial<CliConfig>): Promise<CliConfig> {
  const current = await loadCliConfig();
  const next: CliConfig = { ...current, ...partial };
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    await fs.chmod(CONFIG_PATH, 0o600);
  } catch {
    // Windows often rejects chmod; non-fatal.
  }
  return next;
}

export function getDefaultApiBase(): string {
  return DEFAULT_API_BASE;
}
