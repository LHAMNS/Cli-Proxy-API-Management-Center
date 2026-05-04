import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logsApi } from '@/services/api/logs';
import { parseLogLine } from '@/utils/logParsing';
import type { LogLevel, ParsedLogLine } from '@/utils/logTypes';
import { formatFileSize, formatUnixTimestamp } from '@/utils/format';
import { makeTable } from '../ui/tables';

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  trace: chalk.gray,
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
  fatal: chalk.bgRed.white,
};

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

function statusColor(code?: number): string {
  if (typeof code !== 'number') return '';
  const text = String(code);
  if (code < 300) return chalk.green(text);
  if (code < 400) return chalk.cyan(text);
  if (code < 500) return chalk.yellow(text);
  return chalk.red(text);
}

function formatLine(line: ParsedLogLine): string {
  const time = line.timestamp ? line.timestamp.replace(/^\d{4}-\d{2}-\d{2}[ T]/, '') : '';
  const lvlText = line.level ? LEVEL_COLOR[line.level](line.level.toUpperCase().padEnd(5)) : '     ';
  const status = line.statusCode ? ` ${statusColor(line.statusCode)}` : '';
  const latency = line.latency ? ` ${chalk.dim(line.latency)}` : '';
  const method = line.method ? ` ${chalk.bold(line.method)}` : '';
  const requestPath = line.path ? ` ${line.path}` : '';
  const reqId = line.requestId ? ` ${chalk.dim(`[${line.requestId}]`)}` : '';
  const source = line.source ? ` ${chalk.dim(`(${line.source})`)}` : '';
  const message = line.message ? ` ${line.message}` : '';
  return `${chalk.dim(time)} ${lvlText}${reqId}${source}${status}${latency}${method}${requestPath}${message}`.trim();
}

interface TailOptions {
  follow?: boolean;
  tail?: number;
  level?: LogLevel;
}

async function tailLogs(opts: TailOptions): Promise<void> {
  const tailLimit = opts.tail ?? 200;
  const minRank = opts.level ? LEVEL_RANK[opts.level] : -1;

  const initial = await logsApi.fetchLogs();
  const initialLines = (initial.lines ?? []).slice(-tailLimit);
  initialLines.forEach((line) => {
    const parsed = parseLogLine(line);
    if (minRank >= 0 && (!parsed.level || LEVEL_RANK[parsed.level] < minRank)) return;
    console.log(formatLine(parsed));
  });

  if (!opts.follow) return;

  let cursor = Number(initial['latest-timestamp']) || 0;
  console.error(chalk.dim('-- following (Ctrl-C to stop) --'));
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let next;
    try {
      next = await logsApi.fetchLogs(cursor > 0 ? { after: cursor } : {});
    } catch (err) {
      console.error(chalk.red(`Fetch failed: ${(err as Error).message}`));
      continue;
    }
    cursor = Number(next['latest-timestamp']) || cursor;
    for (const line of next.lines ?? []) {
      const parsed = parseLogLine(line);
      if (minRank >= 0 && (!parsed.level || LEVEL_RANK[parsed.level] < minRank)) continue;
      console.log(formatLine(parsed));
    }
  }
}

interface TraceCandidate {
  requestId: string;
  timestamp?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  level?: LogLevel;
}

async function collectTraceCandidates(limit: number): Promise<TraceCandidate[]> {
  const res = await logsApi.fetchLogs();
  const lines = res.lines ?? [];
  const seen = new Map<string, TraceCandidate>();
  // Walk newest-first so the latest occurrence wins.
  for (let i = lines.length - 1; i >= 0 && seen.size < limit; i--) {
    const parsed = parseLogLine(lines[i]);
    if (!parsed.requestId || seen.has(parsed.requestId)) continue;
    seen.set(parsed.requestId, {
      requestId: parsed.requestId,
      timestamp: parsed.timestamp,
      method: parsed.method,
      path: parsed.path,
      statusCode: parsed.statusCode,
      level: parsed.level,
    });
  }
  return [...seen.values()];
}

async function pickRequestId(limit: number): Promise<string | null> {
  const candidates = await collectTraceCandidates(limit);
  if (candidates.length === 0) {
    console.error(
      chalk.yellow(
        'No request IDs found in recent logs. Pass <id> directly, or run a request first.'
      )
    );
    return null;
  }
  const choice = await prompts({
    type: 'autocomplete',
    name: 'id',
    message: 'Pick a request ID',
    choices: candidates.map((c) => {
      const time = c.timestamp ? c.timestamp.replace(/^\d{4}-\d{2}-\d{2}[ T]/, '') : '????';
      const status = typeof c.statusCode === 'number' ? statusColor(c.statusCode) : '   ';
      const method = c.method ?? '   ';
      const requestPath = c.path ?? '';
      return {
        title: `${time}  ${status}  ${method.padEnd(6)}  ${requestPath}  ${chalk.dim(c.requestId)}`,
        value: c.requestId,
      };
    }),
    suggest: (input: string, choices: Array<{ title: string }>) =>
      Promise.resolve(
        choices.filter((c) => c.title.toLowerCase().includes(input.toLowerCase()))
      ),
  });
  return typeof choice.id === 'string' ? choice.id : null;
}

async function downloadTrace(id: string, dest?: string): Promise<void> {
  const response = await logsApi.downloadRequestLogById(id);
  const blob = response.data as { text: () => Promise<string> } | string | Buffer;
  const text =
    typeof (blob as { text?: () => Promise<string> })?.text === 'function'
      ? await (blob as { text: () => Promise<string> }).text()
      : Buffer.isBuffer(blob)
        ? blob.toString('utf8')
        : String(blob);

  if (dest) {
    const target = path.resolve(dest);
    await fs.writeFile(target, text, 'utf8');
    console.log(chalk.green(`Wrote ${target}`));
    return;
  }
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

async function listErrorLogs(): Promise<void> {
  const res = await logsApi.fetchErrorLogs();
  const files = res.files ?? [];
  if (!files.length) {
    console.log(chalk.dim('No error log files.'));
    return;
  }
  const table = makeTable(['Name', 'Size', 'Modified']);
  for (const file of files) {
    table.push([
      file.name,
      typeof file.size === 'number' ? formatFileSize(file.size) : chalk.dim('—'),
      file.modified ? formatUnixTimestamp(file.modified) : chalk.dim('—'),
    ]);
  }
  console.log(table.toString());
}

async function downloadErrorLog(name: string, dest?: string): Promise<void> {
  const response = await logsApi.downloadErrorLog(name);
  const blob = response.data as { text: () => Promise<string> } | string | Buffer;
  const text =
    typeof (blob as { text?: () => Promise<string> })?.text === 'function'
      ? await (blob as { text: () => Promise<string> }).text()
      : Buffer.isBuffer(blob)
        ? blob.toString('utf8')
        : String(blob);
  if (dest) {
    const target = path.resolve(dest);
    await fs.writeFile(target, text, 'utf8');
    console.log(chalk.green(`Wrote ${target}`));
  } else {
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }
}

async function clearLogs(force: boolean): Promise<void> {
  if (!force) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'ok',
      message: 'Clear all logs on the server?',
      initial: false,
    });
    if (!confirm.ok) return;
  }
  await logsApi.clearLogs();
  console.log(chalk.green('Logs cleared.'));
}

export function registerLogsCommand(program: Command): void {
  const logs = program.command('logs').description('Stream / inspect server logs.');

  logs
    .command('tail', { isDefault: true })
    .description('Tail recent log lines (defaults: last 200, no follow).')
    .option('-f, --follow', 'Follow log stream (poll every 2s).')
    .option('-n, --tail <count>', 'Number of recent lines to print.', (v) => Number(v))
    .option(
      '-l, --level <level>',
      'Minimum level (trace|debug|info|warn|error|fatal)',
      (value) => value.toLowerCase() as LogLevel
    )
    .action(async (opts: TailOptions) => {
      await tailLogs(opts);
    });

  logs
    .command('trace [id]')
    .description(
      'Download the full per-request log blob. With no <id>, lists recent IDs and prompts you to pick one.'
    )
    .option('-o, --out <file>', 'Write to file instead of stdout.')
    .option(
      '-n, --tail <n>',
      'When picking interactively, scan at most N recent IDs (default 50).',
      (v) => Number(v),
      50
    )
    .action(async (id: string | undefined, opts: { out?: string; tail?: number }) => {
      let resolvedId = id?.trim();
      if (!resolvedId) {
        const picked = await pickRequestId(opts.tail ?? 50);
        if (!picked) {
          process.exitCode = 1;
          return;
        }
        resolvedId = picked;
      }
      await downloadTrace(resolvedId, opts.out);
    });

  logs
    .command('errors')
    .description('List per-request error log files saved by the server.')
    .action(async () => {
      await listErrorLogs();
    });

  logs
    .command('download <name>')
    .description('Download an error log file by name.')
    .option('-o, --out <file>', 'Write to file instead of stdout.')
    .action(async (name: string, opts: { out?: string }) => {
      await downloadErrorLog(name, opts.out);
    });

  logs
    .command('clear')
    .description('Clear server log buffer (irreversible).')
    .option('-y, --yes', 'Skip confirmation prompt.')
    .action(async (opts: { yes?: boolean }) => {
      await clearLogs(Boolean(opts.yes));
    });
}
