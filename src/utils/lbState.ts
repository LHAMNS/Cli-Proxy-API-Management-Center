import type { AuthFileItem } from '@/types/authFile';

export type LbState = 'active' | 'standby' | 'disabled';

/**
 * Convention shared by `cpa lb set` and the dashboard:
 * priority 10 = active pool, priority 0/unset = standby pool.
 * The backend selector picks the highest-priority bucket first.
 */
export const PRIORITY_ACTIVE = 10;
export const PRIORITY_STANDBY = 0;

export function authPriority(file: AuthFileItem): number {
  const raw = file.priority;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return 0;
}

export function inferProvider(file: AuthFileItem): string {
  const provider = String(file.provider ?? '').trim();
  if (provider) return provider;
  const type = String(file.type ?? '').trim();
  if (type) return type;
  return 'unknown';
}

/**
 * Per-provider classification: within each provider, accounts in the highest
 * priority bucket render as ACTIVE; any account at a lower priority is STANDBY.
 * If every account in a provider shares the same priority, all are ACTIVE.
 */
export function classifyStates(files: AuthFileItem[]): Map<string, LbState> {
  const result = new Map<string, LbState>();
  const maxByProvider = new Map<string, number>();

  for (const file of files) {
    if (file.disabled === true) continue;
    const provider = inferProvider(file);
    const priority = authPriority(file);
    const current = maxByProvider.get(provider);
    if (current === undefined || priority > current) {
      maxByProvider.set(provider, priority);
    }
  }

  for (const file of files) {
    if (file.disabled === true) {
      result.set(file.name, 'disabled');
      continue;
    }
    const provider = inferProvider(file);
    const max = maxByProvider.get(provider) ?? 0;
    result.set(file.name, authPriority(file) === max ? 'active' : 'standby');
  }

  return result;
}
