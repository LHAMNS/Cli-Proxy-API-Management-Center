import { Command } from 'commander';
import chalk from 'chalk';
import { usageApi } from '@/services/api/usage';
import {
  collectUsageDetails,
  computeKeyStatsFromDetails,
  type UsageDetail,
} from '@/utils/usage';
import { calculateLatencyStatsFromDetails, formatDurationMs } from '@/utils/latency';
import { formatNumber } from '@/utils/format';
import { makeTable } from '../ui/tables';
import { registerUsageAccountSubcommand } from './usageAccount';

const TIME_RANGES: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

function parseDuration(value?: string): number | null {
  if (!value || value.toLowerCase() === 'all') return null;
  const lower = value.toLowerCase();
  if (TIME_RANGES[lower] !== undefined) return TIME_RANGES[lower];
  const match = lower.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Unrecognised duration "${value}". Try 1h, 6h, 24h, 7d, or "all".`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return n * multiplier;
}

interface ModelBucket {
  model: string;
  requests: number;
  failed: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  details: UsageDetail[];
}

function bucketByModel(details: UsageDetail[]): ModelBucket[] {
  const buckets = new Map<string, ModelBucket>();
  for (const detail of details) {
    const key = detail.__modelName || 'Unknown';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        model: key,
        requests: 0,
        failed: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        details: [],
      };
      buckets.set(key, bucket);
    }
    bucket.requests += 1;
    if (detail.failed) bucket.failed += 1;
    bucket.inputTokens += Number(detail.tokens?.input_tokens) || 0;
    bucket.cachedTokens += Number(detail.tokens?.cached_tokens ?? detail.tokens?.cache_tokens) || 0;
    bucket.outputTokens += Number(detail.tokens?.output_tokens) || 0;
    bucket.reasoningTokens += Number(detail.tokens?.reasoning_tokens) || 0;
    bucket.totalTokens += Number(detail.tokens?.total_tokens) || 0;
    bucket.details.push(detail);
  }
  return [...buckets.values()].sort((a, b) => b.requests - a.requests);
}

function renderModelTable(buckets: ModelBucket[]): void {
  if (!buckets.length) {
    console.log(chalk.dim('  (no requests in window)'));
    return;
  }
  const table = makeTable([
    'Model',
    'Reqs',
    'Failed',
    'Input',
    'Cached',
    'Output',
    'Reason',
    'Total',
    'Avg latency',
  ]);
  for (const b of buckets) {
    const latency = calculateLatencyStatsFromDetails(b.details);
    table.push([
      b.model,
      formatNumber(b.requests),
      b.failed > 0 ? chalk.red(formatNumber(b.failed)) : chalk.green('0'),
      formatNumber(b.inputTokens),
      formatNumber(b.cachedTokens),
      formatNumber(b.outputTokens),
      formatNumber(b.reasoningTokens),
      chalk.bold(formatNumber(b.totalTokens)),
      latency.averageMs !== null ? formatDurationMs(latency.averageMs) : chalk.dim('—'),
    ]);
  }
  console.log(table.toString());
}

function renderKeyStatsTable(details: UsageDetail[]): void {
  const stats = computeKeyStatsFromDetails(details);
  const sources = Object.entries(stats.bySource);
  const auths = Object.entries(stats.byAuthIndex);

  if (!sources.length && !auths.length) {
    console.log(chalk.dim('  (no source/auth-index attribution)'));
    return;
  }

  if (sources.length) {
    console.log(chalk.bold('\nBy source:'));
    const table = makeTable(['Source', 'Success', 'Failure', 'Total']);
    for (const [src, bucket] of sources.sort((a, b) => b[1].success + b[1].failure - (a[1].success + a[1].failure))) {
      const total = bucket.success + bucket.failure;
      table.push([
        src,
        chalk.green(formatNumber(bucket.success)),
        bucket.failure > 0 ? chalk.red(formatNumber(bucket.failure)) : '0',
        formatNumber(total),
      ]);
    }
    console.log(table.toString());
  }

  if (auths.length) {
    console.log(chalk.bold('\nBy auth-index:'));
    const table = makeTable(['Auth index', 'Success', 'Failure', 'Total']);
    for (const [idx, bucket] of auths.sort((a, b) => b[1].success + b[1].failure - (a[1].success + a[1].failure))) {
      const total = bucket.success + bucket.failure;
      table.push([
        idx,
        chalk.green(formatNumber(bucket.success)),
        bucket.failure > 0 ? chalk.red(formatNumber(bucket.failure)) : '0',
        formatNumber(total),
      ]);
    }
    console.log(table.toString());
  }
}

function filterDetails(
  details: UsageDetail[],
  windowMs: number | null,
  source?: string
): UsageDetail[] {
  const cutoff = windowMs !== null ? Date.now() - windowMs : null;
  return details.filter((d) => {
    if (cutoff !== null && d.__timestampMs !== undefined && d.__timestampMs < cutoff) return false;
    if (source && d.source !== source) return false;
    return true;
  });
}

function buildJsonReport(filtered: UsageDetail[]): Record<string, unknown> {
  const buckets = bucketByModel(filtered);
  const keyStats = computeKeyStatsFromDetails(filtered);
  return {
    requests: filtered.length,
    byModel: buckets.map((b) => {
      const latency = calculateLatencyStatsFromDetails(b.details);
      return {
        model: b.model,
        requests: b.requests,
        failed: b.failed,
        tokens: {
          input: b.inputTokens,
          cached: b.cachedTokens,
          output: b.outputTokens,
          reasoning: b.reasoningTokens,
          total: b.totalTokens,
        },
        averageLatencyMs: latency.averageMs,
        sampleCount: latency.sampleCount,
      };
    }),
    bySource: keyStats.bySource,
    byAuthIndex: keyStats.byAuthIndex,
    details: filtered,
  };
}

export function registerUsageCommand(program: Command): void {
  const usage = program
    .command('usage')
    .description('Show token usage statistics aggregated by model and by key/auth.')
    .option('-l, --last <window>', 'Time window: 1h, 6h, 24h, 7d, all (default: 24h)', '24h')
    .option('-s, --source <source>', 'Filter by source (e.g. k:abcd…)')
    .option('--json', 'Output JSON (full bucket + raw details) instead of tables.')
    .action(async (opts: { last?: string; source?: string; json?: boolean }) => {
      const windowMs = parseDuration(opts.last ?? '24h');
      const data = await usageApi.getUsage();
      const allDetails = collectUsageDetails(data);
      const filtered = filterDetails(allDetails, windowMs, opts.source?.trim() || undefined);

      if (opts.json) {
        console.log(JSON.stringify(buildJsonReport(filtered), null, 2));
        return;
      }

      const windowLabel = windowMs === null ? 'all time' : opts.last ?? '24h';
      console.log(chalk.bold(`Usage (${windowLabel})  —  ${filtered.length} requests`));
      console.log(chalk.bold('\nBy model:'));
      renderModelTable(bucketByModel(filtered));
      renderKeyStatsTable(filtered);
    });

  registerUsageAccountSubcommand(usage);
}
