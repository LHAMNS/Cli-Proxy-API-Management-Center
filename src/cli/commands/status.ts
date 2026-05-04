import { Command } from 'commander';
import chalk from 'chalk';
import { authFilesApi } from '@/services/api/authFiles';
import { configApi } from '@/services/api/config';
import { usageApi } from '@/services/api/usage';
import { versionApi } from '@/services/api/version';
import { apiClient } from '@/services/api/client';
import type { AuthFileItem } from '@/types/authFile';
import { classifyStates, inferProvider, type LbState } from '@/utils/lbState';
import {
  aggregateMonthlyTokens,
  collectUsageDetails,
  formatCompactNumber,
  type MonthlyTokenTotals,
} from '@/utils/usage';
import { formatNumber, formatUnixTimestamp } from '@/utils/format';
import { getCachedCliConfig } from '../state/bootstrap';

interface ProviderRollup {
  provider: string;
  active: number;
  standby: number;
  disabled: number;
  total: number;
}

interface AlertEntry {
  provider: string;
  name: string;
  message: string;
  retryAt?: string;
}

function rollupAccounts(files: AuthFileItem[], states: Map<string, LbState>): ProviderRollup[] {
  const buckets = new Map<string, ProviderRollup>();
  for (const file of files) {
    const provider = inferProvider(file);
    let bucket = buckets.get(provider);
    if (!bucket) {
      bucket = { provider, active: 0, standby: 0, disabled: 0, total: 0 };
      buckets.set(provider, bucket);
    }
    const state = states.get(file.name) ?? 'standby';
    bucket[state] += 1;
    bucket.total += 1;
  }
  return [...buckets.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

function collectAlerts(files: AuthFileItem[]): AlertEntry[] {
  const alerts: AlertEntry[] = [];
  for (const file of files) {
    if (file.disabled === true) continue;
    const provider = inferProvider(file);

    if (file.unavailable === true) {
      const retryFormatted = formatUnixTimestamp(file.next_retry_after);
      alerts.push({
        provider,
        name: file.name,
        message: 'cooling down',
        retryAt: retryFormatted || undefined,
      });
      continue;
    }

    const status = String(file.status ?? '').trim().toLowerCase();
    if (status === 'error') {
      const detail = String(file.statusMessage ?? '').trim();
      alerts.push({
        provider,
        name: file.name,
        message: detail ? `error: ${detail}` : 'error',
      });
    }
  }
  return alerts;
}

function renderHeader(apiBase: string): void {
  const version = apiClient.getLastServerVersion();
  const buildDate = apiClient.getLastServerBuildDate();
  const parts: string[] = [chalk.bold('Server'), chalk.cyan(apiBase)];
  if (version) parts.push(chalk.dim(`cliproxyapi ${version}`));
  if (buildDate) parts.push(chalk.dim(`built ${buildDate}`));
  console.log(parts.join('  '));
}

function renderAccounts(rollups: ProviderRollup[]): void {
  if (rollups.length === 0) {
    console.log(chalk.dim('No accounts logged in. Run `cpa login <provider>` to add one.'));
    return;
  }

  const providerWidth = Math.max(...rollups.map((r) => r.provider.length), 9);
  console.log(chalk.bold('\nAccounts logged in'));
  for (const r of rollups) {
    const segments: string[] = [];
    if (r.active > 0) segments.push(chalk.green(`ACTIVE ${r.active}`));
    if (r.standby > 0) segments.push(chalk.yellow(`STANDBY ${r.standby}`));
    if (r.disabled > 0) segments.push(chalk.red(`DISABLED ${r.disabled}`));
    const main = segments.length ? segments.join('  ') : chalk.dim('(none)');
    const padded = r.provider.padEnd(providerWidth, ' ');
    console.log(`  ${padded}  ${main}   ${chalk.dim(`(${r.total} total)`)}`);
  }
}

function renderMonthlyTotals(totals: MonthlyTokenTotals): void {
  console.log(chalk.bold(`\nThis month so far (${totals.windowLabel})`));
  if (totals.requests === 0) {
    console.log(chalk.dim('  No requests recorded this month yet.'));
    return;
  }
  const successRate = ((totals.requests - totals.failed) / totals.requests) * 100;
  const successColor = successRate >= 95 ? chalk.green : successRate >= 80 ? chalk.yellow : chalk.red;
  console.log(
    `  Total requests   ${chalk.bold(formatNumber(totals.requests))}   ` +
      `(${successColor(`${successRate.toFixed(1)}% success`)})`
  );
  const t = totals.tokens;
  console.log(
    `  Tokens           in ${formatCompactNumber(t.input)}  ` +
      `cached ${formatCompactNumber(t.cached)}  ` +
      `out ${formatCompactNumber(t.output)}  ` +
      `reasoning ${formatCompactNumber(t.reasoning)}   ` +
      `total ${chalk.bold(formatCompactNumber(t.total))}`
  );
}

function renderAlerts(alerts: AlertEntry[]): void {
  if (alerts.length === 0) return;
  console.log(chalk.bold('\nActive alerts'));
  for (const alert of alerts) {
    const tail = alert.retryAt ? `, retry ${alert.retryAt}` : '';
    console.log(`  ${chalk.yellow('!')} ${alert.provider}:${alert.name}  ${alert.message}${tail}`);
  }
}

export async function runStatusDashboard(asJson: boolean = false): Promise<void> {
  // Trigger one cheap call first so apiClient caches version/build headers,
  // then run the heavier queries in parallel.
  await versionApi.checkLatest().catch(() => undefined);

  const [authListing, usageDataRaw, strategy] = await Promise.all([
    authFilesApi.list().catch((err: Error) => {
      console.error(chalk.yellow(`auth-files unreachable: ${err.message}`));
      return { files: [] };
    }),
    usageApi.getUsage().catch((err: Error) => {
      console.error(chalk.yellow(`usage unreachable: ${err.message}`));
      return null;
    }),
    configApi.getRoutingStrategy().catch(() => ''),
  ]);

  const files = authListing.files ?? [];
  const states = classifyStates(files);
  const rollups = rollupAccounts(files, states);
  const details = usageDataRaw ? collectUsageDetails(usageDataRaw) : [];
  const monthly = aggregateMonthlyTokens(details);
  const alerts = collectAlerts(files);

  const cliConfig = getCachedCliConfig();
  const apiBase = (cliConfig.apiBase ?? 'http://localhost:8317').trim();

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          server: {
            url: apiBase,
            version: apiClient.getLastServerVersion(),
            build_date: apiClient.getLastServerBuildDate(),
            routing_strategy: strategy || null,
          },
          accounts: rollups,
          totals: monthly,
          alerts,
        },
        null,
        2
      )
    );
    return;
  }

  renderHeader(apiBase);
  if (strategy) console.log(chalk.dim(`Routing strategy: ${strategy}`));
  renderAccounts(rollups);
  renderMonthlyTotals(monthly);
  renderAlerts(alerts);
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('At-a-glance dashboard: accounts, monthly usage, alerts.')
    .option('--json', 'Output JSON instead of the formatted dashboard.')
    .action(async (opts: { json?: boolean }) => {
      await runStatusDashboard(Boolean(opts.json));
    });

  // Bare `cpa` invocation falls through to the dashboard.
  program.action(async () => {
    await runStatusDashboard(false);
  });
}
