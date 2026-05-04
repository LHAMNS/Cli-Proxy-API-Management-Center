import { Command } from 'commander';
import chalk from 'chalk';
import { authFilesApi } from '@/services/api/authFiles';
import { usageApi } from '@/services/api/usage';
import type { AuthFileItem } from '@/types/authFile';
import {
  authPriority,
  classifyStates,
  inferProvider,
  type LbState,
} from '@/utils/lbState';
import {
  collectUsageDetails,
  formatCompactNumber,
  normalizeAuthIndex,
  type UsageDetail,
} from '@/utils/usage';
import { formatNumber, formatUnixTimestamp } from '@/utils/format';
import { makeTable } from '../ui/tables';

const TIME_RANGES: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function parseDuration(value: string | undefined, fallback = '30d'): number | null {
  const raw = (value ?? fallback).trim().toLowerCase();
  if (raw === 'all' || raw === '') return null;
  if (TIME_RANGES[raw] !== undefined) return TIME_RANGES[raw];
  const match = raw.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Unrecognised duration "${value}". Try 1h, 6h, 24h, 7d, 30d, or "all".`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return n * multiplier;
}

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

type FindResult =
  | { kind: 'one'; file: AuthFileItem }
  | { kind: 'multiple'; matches: AuthFileItem[] }
  | { kind: 'none' };

function findAccount(files: AuthFileItem[], query: string): FindResult {
  const exact = files.find((f) => f.name === query);
  if (exact) return { kind: 'one', file: exact };

  const trimmed = query.trim().toLowerCase();
  const byEmail = files.filter((f) => String(f.email ?? '').trim().toLowerCase() === trimmed);
  if (byEmail.length === 1) return { kind: 'one', file: byEmail[0] };

  const byContains = files.filter((f) => {
    const haystack = `${f.name}\n${f.email ?? ''}\n${f.account ?? ''}`.toLowerCase();
    return haystack.includes(trimmed);
  });

  if (byContains.length === 1) return { kind: 'one', file: byContains[0] };
  if (byContains.length > 1) return { kind: 'multiple', matches: byContains };
  return { kind: 'none' };
}

interface ModelBucket {
  model: string;
  requests: number;
  failed: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

function bucketByModel(details: UsageDetail[]): ModelBucket[] {
  const map = new Map<string, ModelBucket>();
  for (const detail of details) {
    const key = detail.__modelName || 'Unknown';
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        model: key,
        requests: 0,
        failed: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      };
      map.set(key, bucket);
    }
    bucket.requests += 1;
    if (detail.failed) bucket.failed += 1;
    const t = detail.tokens;
    bucket.inputTokens += Number(t?.input_tokens) || 0;
    bucket.outputTokens += Number(t?.output_tokens) || 0;
    bucket.reasoningTokens += Number(t?.reasoning_tokens) || 0;
    bucket.cachedTokens += Number(t?.cached_tokens ?? t?.cache_tokens) || 0;
    bucket.totalTokens += Number(t?.total_tokens) || 0;
  }
  return [...map.values()].sort((a, b) => b.requests - a.requests);
}

interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

function sumTokenTotals(details: UsageDetail[]): TokenTotals {
  const totals: TokenTotals = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  for (const detail of details) {
    const t = detail.tokens;
    totals.input += Number(t?.input_tokens) || 0;
    totals.output += Number(t?.output_tokens) || 0;
    totals.reasoning += Number(t?.reasoning_tokens) || 0;
    totals.cached += Number(t?.cached_tokens ?? t?.cache_tokens) || 0;
    totals.total += Number(t?.total_tokens) || 0;
  }
  return totals;
}

function renderAccountInfo(file: AuthFileItem, state: LbState): void {
  const provider = inferProvider(file);
  const priority = authPriority(file);
  const lifetimeSuccess = typeof file.success === 'number' ? file.success : 0;
  const lifetimeFailed = typeof file.failed === 'number' ? file.failed : 0;

  console.log(chalk.bold('Account'));
  console.log(`  name      ${chalk.cyan(file.name)}`);
  console.log(`  provider  ${provider}`);
  console.log(
    `  state     ${badgeForState(state)}  ${chalk.dim(`priority ${priority}${priority === 0 ? ' (default)' : ''}`)}`
  );
  if (file.unavailable === true) {
    const retry = formatUnixTimestamp(file.next_retry_after);
    console.log(
      `  health    ${chalk.red('cooling down')}${retry ? chalk.dim(`  retry ${retry}`) : ''}`
    );
  } else if (typeof file.status === 'string' && file.status && file.status !== 'active') {
    const detail = String(file.statusMessage ?? '').trim();
    console.log(`  health    ${chalk.yellow(file.status)}${detail ? chalk.dim(`  ${detail}`) : ''}`);
  } else {
    console.log(`  health    ${chalk.green('ok')}`);
  }
  if (file.email) console.log(`  email     ${file.email}`);

  const idToken = file.id_token;
  if (idToken && (idToken.plan_type || idToken.chatgpt_subscription_active_until)) {
    const planText = idToken.plan_type ?? 'unknown';
    const until = formatUnixTimestamp(idToken.chatgpt_subscription_active_until);
    const tail = until ? `  ${chalk.dim(`active until ${until}`)}` : '';
    console.log(`  plan      ${chalk.bold(planText)}${tail}`);
  }

  console.log(
    `  lifetime  ${chalk.green(formatNumber(lifetimeSuccess) + ' success')}  ` +
      (lifetimeFailed > 0
        ? chalk.red(formatNumber(lifetimeFailed) + ' failed')
        : chalk.dim('0 failed'))
  );
}

function renderTotals(label: string, details: UsageDetail[]): void {
  console.log(chalk.bold(`\n${label}`));
  if (details.length === 0) {
    console.log(chalk.dim('  No requests recorded for this account in window.'));
    return;
  }
  const totals = sumTokenTotals(details);
  const failed = details.reduce((acc, d) => acc + (d.failed ? 1 : 0), 0);
  const successRate = ((details.length - failed) / details.length) * 100;
  const successColor =
    successRate >= 95 ? chalk.green : successRate >= 80 ? chalk.yellow : chalk.red;

  console.log(
    `  Requests   ${chalk.bold(formatNumber(details.length))}   ` +
      `(${successColor(`${successRate.toFixed(1)}% success`)}, ${formatNumber(failed)} failed)`
  );
  console.log(
    `  Tokens     in ${formatCompactNumber(totals.input)}  ` +
      `cached ${formatCompactNumber(totals.cached)}  ` +
      `out ${formatCompactNumber(totals.output)}  ` +
      `reasoning ${formatCompactNumber(totals.reasoning)}   ` +
      `total ${chalk.bold(formatCompactNumber(totals.total))}`
  );
}

function renderTopModels(details: UsageDetail[], limit = 5): void {
  if (details.length === 0) return;
  const buckets = bucketByModel(details).slice(0, limit);
  if (buckets.length === 0) return;
  console.log(chalk.bold(`\nTop models (${buckets.length})`));
  const table = makeTable(['Model', 'Reqs', 'Failed', 'Input', 'Cached', 'Output', 'Reason', 'Total']);
  for (const b of buckets) {
    table.push([
      b.model,
      formatNumber(b.requests),
      b.failed > 0 ? chalk.red(formatNumber(b.failed)) : chalk.dim('0'),
      formatCompactNumber(b.inputTokens),
      formatCompactNumber(b.cachedTokens),
      formatCompactNumber(b.outputTokens),
      formatCompactNumber(b.reasoningTokens),
      chalk.bold(formatCompactNumber(b.totalTokens)),
    ]);
  }
  console.log(table.toString());
}

function renderRecentActivity(details: UsageDetail[], limit = 10): void {
  if (details.length === 0) return;
  const sorted = [...details].sort((a, b) => (b.__timestampMs ?? 0) - (a.__timestampMs ?? 0));
  const recent = sorted.slice(0, limit);
  console.log(chalk.bold(`\nRecent activity (last ${recent.length})`));
  const table = makeTable(['When', 'Model', 'Result', 'Tokens']);
  for (const detail of recent) {
    const total = Number(detail.tokens?.total_tokens) || 0;
    table.push([
      formatUnixTimestamp(detail.__timestampMs ?? detail.timestamp),
      detail.__modelName ?? chalk.dim('—'),
      detail.failed ? chalk.red('FAIL') : chalk.green('ok'),
      total > 0 ? formatCompactNumber(total) : chalk.dim('—'),
    ]);
  }
  console.log(table.toString());
}

async function runUsageAccount(
  query: string,
  opts: { last?: string; json?: boolean }
): Promise<void> {
  const windowMs = parseDuration(opts.last);
  const listing = await authFilesApi.list();
  const files = listing.files ?? [];
  const found = findAccount(files, query);

  if (found.kind === 'none') {
    console.error(
      chalk.red(`No auth file matches "${query}".`),
      `Run \`cpa auth ls\` to see available names.`
    );
    process.exitCode = 2;
    return;
  }

  if (found.kind === 'multiple') {
    console.error(chalk.red(`Multiple auth files match "${query}":`));
    for (const match of found.matches) {
      console.error(`  ${match.name}` + (match.email ? chalk.dim(`  (${match.email})`) : ''));
    }
    console.error(chalk.dim('Use the full filename to disambiguate.'));
    process.exitCode = 2;
    return;
  }

  const file = found.file;
  const states = classifyStates(files);
  const state = states.get(file.name) ?? 'standby';

  const authIndexKey = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  let filteredDetails: UsageDetail[] = [];
  let usageError: string | null = null;

  try {
    const usageData = await usageApi.getUsage();
    const allDetails = collectUsageDetails(usageData);
    const cutoff = windowMs !== null ? Date.now() - windowMs : 0;
    filteredDetails = allDetails.filter((detail) => {
      if (windowMs !== null) {
        const ts = detail.__timestampMs ?? 0;
        if (ts < cutoff) return false;
      }
      if (!authIndexKey) return false;
      const detailKey = normalizeAuthIndex(detail.auth_index);
      return detailKey === authIndexKey;
    });
  } catch (err) {
    usageError = (err as Error).message;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          account: file,
          state,
          window: opts.last ?? '30d',
          totals: sumTokenTotals(filteredDetails),
          requests: filteredDetails.length,
          failed: filteredDetails.filter((d) => d.failed).length,
          top_models: bucketByModel(filteredDetails).slice(0, 5),
          recent: [...filteredDetails]
            .sort((a, b) => (b.__timestampMs ?? 0) - (a.__timestampMs ?? 0))
            .slice(0, 10),
          usage_error: usageError,
        },
        null,
        2
      )
    );
    return;
  }

  renderAccountInfo(file, state);

  const windowLabel = windowMs === null ? 'all time' : opts.last ?? '30d';
  if (usageError) {
    console.log(chalk.yellow(`\nCould not load usage details: ${usageError}`));
  } else if (!authIndexKey) {
    console.log(
      chalk.dim(`\nNo auth_index recorded for this account; usage cannot be attributed yet.`)
    );
  } else {
    renderTotals(`Last ${windowLabel}`, filteredDetails);
    renderTopModels(filteredDetails);
    renderRecentActivity(filteredDetails);
  }
}

export function registerUsageAccountSubcommand(usage: Command): void {
  usage
    .command('account <name>')
    .description(
      'Per-account usage breakdown. Accepts the full filename, an email, ' +
        'or a unique substring of either. Use `cpa auth ls` to list candidates.'
    )
    .option('-l, --last <window>', 'Time window: 1h, 6h, 24h, 7d, 30d, all (default: 30d)', '30d')
    .option('--json', 'Output JSON instead of formatted tables.')
    .action(async (name: string, opts: { last?: string; json?: boolean }) => {
      await runUsageAccount(name, opts);
    });
}
