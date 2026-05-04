import { Command } from 'commander';
import chalk from 'chalk';
import { authFilesApi } from '@/services/api/authFiles';
import { configApi } from '@/services/api/config';
import type { AuthFileItem } from '@/types/authFile';
import { formatUnixTimestamp } from '@/utils/format';
import {
  PRIORITY_ACTIVE,
  PRIORITY_STANDBY,
  authPriority,
  classifyStates,
  inferProvider,
  type LbState,
} from '@/utils/lbState';
import { makeTable } from '../ui/tables';

const VALID_STRATEGIES = new Set(['round-robin', 'fill-first']);

function badgeForState(state: LbState): string {
  switch (state) {
    case 'active':
      return chalk.green('ACTIVE');
    case 'standby':
      return chalk.yellow('STANDBY');
    case 'disabled':
      return chalk.red('DISABLED');
  }
}

function healthHint(file: AuthFileItem): string {
  if (file.unavailable === true) {
    const formatted = formatUnixTimestamp(file.next_retry_after);
    return formatted ? chalk.red(`cooling → ${formatted}`) : chalk.red('cooling');
  }
  const status = String(file.status ?? '').trim().toLowerCase();
  if (status && status !== 'active' && status !== 'ok' && status !== 'available') {
    return chalk.yellow(status);
  }
  return chalk.green('ok');
}

async function lbStatus(asJson: boolean): Promise<void> {
  const [strategy, listing] = await Promise.all([
    configApi.getRoutingStrategy(),
    authFilesApi.list(),
  ]);
  const files = listing.files ?? [];
  const states = classifyStates(files);

  if (asJson) {
    const grouped: Record<string, Record<LbState, AuthFileItem[]>> = {};
    for (const file of files) {
      const provider = inferProvider(file);
      if (!grouped[provider]) {
        grouped[provider] = { active: [], standby: [], disabled: [] };
      }
      const state = states.get(file.name) ?? 'standby';
      grouped[provider][state].push(file);
    }
    console.log(JSON.stringify({ strategy, providers: grouped }, null, 2));
    return;
  }

  console.log(chalk.bold(`Routing strategy: `) + chalk.cyan(strategy));
  if (files.length === 0) {
    console.log(chalk.dim('No auth files. Run `cpa login <provider>` first.'));
    return;
  }

  const sorted = [...files].sort((a, b) => {
    const pa = inferProvider(a);
    const pb = inferProvider(b);
    if (pa !== pb) return pa.localeCompare(pb);
    const sa = states.get(a.name) ?? 'standby';
    const sb = states.get(b.name) ?? 'standby';
    const order: Record<LbState, number> = { active: 0, standby: 1, disabled: 2 };
    if (order[sa] !== order[sb]) return order[sa] - order[sb];
    return a.name.localeCompare(b.name);
  });

  const table = makeTable(['Provider', 'Name', 'State', 'Priority', 'Health', 'Reqs', 'Failed']);
  for (const file of sorted) {
    const state = states.get(file.name) ?? 'standby';
    const priority = authPriority(file);
    table.push([
      inferProvider(file),
      file.name,
      badgeForState(state),
      priority === 0 ? chalk.dim('—') : String(priority),
      healthHint(file),
      typeof file.recent_requests === 'number' ? String(file.recent_requests) : chalk.dim('—'),
      typeof file.failed === 'number' && file.failed > 0
        ? chalk.red(String(file.failed))
        : chalk.dim('0'),
    ]);
  }
  console.log(table.toString());
  console.log(
    chalk.dim(
      `Active = top priority bucket per provider; standby = lower buckets (used when active pool is exhausted).`
    )
  );
}

async function lbMode(strategy: string): Promise<void> {
  const value = strategy.trim().toLowerCase();
  if (!VALID_STRATEGIES.has(value)) {
    console.error(
      chalk.red(`Unknown strategy "${strategy}".`),
      `Use one of: ${[...VALID_STRATEGIES].join(', ')}.`
    );
    process.exitCode = 2;
    return;
  }
  await configApi.updateRoutingStrategy(value);
  console.log(chalk.green(`Routing strategy → ${value}`));
}

async function lbSet(name: string, rawState: string): Promise<void> {
  const next = rawState.trim().toLowerCase() as LbState;
  if (next !== 'active' && next !== 'standby' && next !== 'disabled') {
    console.error(
      chalk.red(`Unknown state "${rawState}".`),
      `Use one of: active, standby, disabled.`
    );
    process.exitCode = 2;
    return;
  }

  const listing = await authFilesApi.list();
  const file = (listing.files ?? []).find((f) => f.name === name);
  if (!file) {
    console.error(chalk.red(`No auth file named "${name}".`));
    process.exitCode = 2;
    return;
  }

  if (next === 'disabled') {
    if (file.disabled !== true) {
      await authFilesApi.setStatus(name, true);
    }
    console.log(`${chalk.bold(name)} → ${badgeForState('disabled')} (priority preserved)`);
    return;
  }

  // For active/standby we ensure disabled=false then set priority.
  if (file.disabled === true) {
    await authFilesApi.setStatus(name, false);
  }
  const targetPriority = next === 'active' ? PRIORITY_ACTIVE : PRIORITY_STANDBY;
  if (authPriority(file) !== targetPriority) {
    await authFilesApi.setFields(name, { priority: targetPriority });
  }

  // Warn when the resulting state is meaningless: only one non-disabled account
  // in this provider, or all share the same priority.
  const fresh = await authFilesApi.list();
  const peers = (fresh.files ?? []).filter(
    (f) => f.disabled !== true && inferProvider(f) === inferProvider(file)
  );
  const distinctPriorities = new Set(peers.map(authPriority));
  console.log(`${chalk.bold(name)} → ${badgeForState(next)} (priority ${targetPriority})`);
  if (peers.length > 1 && distinctPriorities.size === 1) {
    console.log(
      chalk.dim(
        `Note: all ${peers.length} active "${inferProvider(file)}" accounts share the same priority, ` +
          `so the standby/active distinction is currently a no-op.`
      )
    );
  }
}

export function registerLbCommand(program: Command): void {
  const lb = program
    .command('lb')
    .description('Inspect and control multi-account load-balancer state.');

  lb
    .command('status')
    .description('Print routing strategy + per-account active/standby/disabled state.')
    .option('--json', 'Output JSON instead of a table.')
    .action(async (opts: { json?: boolean }) => {
      await lbStatus(Boolean(opts.json));
    });

  lb
    .command('mode <strategy>')
    .description('Set global routing strategy: round-robin or fill-first.')
    .action(async (strategy: string) => {
      await lbMode(strategy);
    });

  lb
    .command('set <name> <state>')
    .description(
      'Set a single auth file to active | standby | disabled. ' +
        'Active = top priority pool; standby = fallback pool; disabled = excluded entirely.'
    )
    .action(async (name: string, state: string) => {
      await lbSet(name, state);
    });
}
