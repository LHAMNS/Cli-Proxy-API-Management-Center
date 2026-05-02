import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authFilesApi } from '@/services/api/authFiles';
import type { AuthFileItem } from '@/types';
import { formatUnixTimestamp, formatFileSize } from '@/utils/format';
import { makeTable, statusBadge } from '../ui/tables';

const PROVIDER_PREFIX_MAP: Record<string, string> = {
  codex: 'codex',
  anthropic: 'anthropic',
  antigravity: 'antigravity',
  'gemini-cli': 'gemini',
};

function shortType(file: AuthFileItem): string {
  const t = String(file.type ?? '').trim();
  if (t) return t;
  if (file.provider) return String(file.provider);
  return chalk.dim('—');
}

function modifiedString(file: AuthFileItem): string {
  if (typeof file.modified === 'number') return formatUnixTimestamp(file.modified);
  if (file.lastRefresh) return formatUnixTimestamp(file.lastRefresh);
  return chalk.dim('—');
}

async function listAuthFiles(showAll: boolean, asJson: boolean): Promise<void> {
  const res = await authFilesApi.list();
  const files = res.files ?? [];
  const visible = showAll ? files : files.filter((f) => f.disabled !== true);

  if (asJson) {
    console.log(JSON.stringify(visible, null, 2));
    return;
  }

  if (visible.length === 0) {
    console.log(chalk.dim('No auth files.'));
    return;
  }

  const table = makeTable(['Name', 'Type', 'Status', 'Size', 'Modified']);
  visible.forEach((file) => {
    table.push([
      file.name,
      shortType(file),
      statusBadge(file.disabled === true),
      typeof file.size === 'number' ? formatFileSize(file.size) : chalk.dim('—'),
      modifiedString(file),
    ]);
  });
  console.log(table.toString());
  console.log(
    chalk.dim(`Total: ${files.length}` + (showAll ? '' : ' (use --all to include disabled)'))
  );
}

async function deleteFiles(names: string[], all: boolean, force: boolean): Promise<void> {
  if (all) {
    if (!force) {
      const confirm = await prompts({
        type: 'confirm',
        name: 'ok',
        message: 'Delete ALL auth files?',
        initial: false,
      });
      if (!confirm.ok) return;
    }
    await authFilesApi.deleteAll();
    console.log(chalk.green('All auth files removed.'));
    return;
  }

  if (!names.length) {
    console.error(chalk.red('Specify one or more <name> arguments, or pass --all.'));
    process.exitCode = 2;
    return;
  }

  const result = await authFilesApi.deleteFiles(names);
  if (result.failed.length > 0) {
    console.warn(chalk.yellow(`Some deletions failed:`));
    for (const failure of result.failed) {
      console.warn(`  ${chalk.red(failure.name)}  ${failure.error}`);
    }
  }
  console.log(chalk.green(`Deleted ${result.deleted} of ${names.length}.`));
}

async function toggleFile(name: string, force?: 'enable' | 'disable'): Promise<void> {
  const list = await authFilesApi.list();
  const file = list.files?.find((f) => f.name === name);
  if (!file) {
    console.error(chalk.red(`No auth file named "${name}".`));
    process.exitCode = 2;
    return;
  }
  const currentlyDisabled = file.disabled === true;
  const nextDisabled = force === 'enable' ? false : force === 'disable' ? true : !currentlyDisabled;
  const res = await authFilesApi.setStatus(name, nextDisabled);
  console.log(`${chalk.bold(name)} → ${statusBadge(nextDisabled)} (server status: ${res.status})`);
}

async function catFile(name: string, raw: boolean): Promise<void> {
  if (raw) {
    const text = await authFilesApi.downloadText(name);
    process.stdout.write(text);
    return;
  }
  const obj = await authFilesApi.downloadJsonObject(name);
  console.log(JSON.stringify(obj, null, 2));
}

async function saveFile(name: string, dest: string): Promise<void> {
  const text = await authFilesApi.downloadText(name);
  const target = path.resolve(dest);
  await fs.writeFile(target, text, 'utf8');
  console.log(chalk.green(`Wrote ${target}`));
}

async function reloginFile(name: string): Promise<void> {
  const lower = name.toLowerCase();
  const provider = (Object.keys(PROVIDER_PREFIX_MAP) as Array<keyof typeof PROVIDER_PREFIX_MAP>).find(
    (key) => lower.startsWith(PROVIDER_PREFIX_MAP[key])
  );
  if (!provider) {
    console.error(
      chalk.red(`Cannot infer provider from filename "${name}".`),
      `Run \`cpa login <provider>\` directly.`
    );
    process.exitCode = 2;
    return;
  }
  console.log(chalk.dim(`Removing existing auth file ${name}…`));
  await authFilesApi.deleteFile(name);
  console.log(
    chalk.cyan(
      `Now run \`cpa login ${provider}\` to obtain a fresh credential (the prior file has been removed).`
    )
  );
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Manage auth files (credentials).');

  auth
    .command('ls')
    .description('List auth files.')
    .option('-a, --all', 'Include disabled entries.')
    .option('--json', 'Output JSON instead of a table.')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      await listAuthFiles(Boolean(opts.all), Boolean(opts.json));
    });

  auth
    .command('rm <names...>')
    .description('Delete one or more auth files by name.')
    .option('--all', 'Delete every auth file (requires confirmation).')
    .option('-y, --yes', 'Skip the --all confirmation prompt.')
    .action(async (names: string[], opts: { all?: boolean; yes?: boolean }) => {
      await deleteFiles(names, Boolean(opts.all), Boolean(opts.yes));
    });

  auth
    .command('toggle <name>')
    .description('Toggle disabled state for an auth file.')
    .option('--enable', 'Force enable.')
    .option('--disable', 'Force disable.')
    .action(async (name: string, opts: { enable?: boolean; disable?: boolean }) => {
      const force = opts.enable ? 'enable' : opts.disable ? 'disable' : undefined;
      await toggleFile(name, force);
    });

  auth
    .command('cat <name>')
    .description('Print an auth file to stdout (default: parsed JSON).')
    .option('--raw', 'Print raw text instead of pretty JSON.')
    .action(async (name: string, opts: { raw?: boolean }) => {
      await catFile(name, Boolean(opts.raw));
    });

  auth
    .command('save <name> <dest>')
    .description('Save an auth file to a local path.')
    .action(async (name: string, dest: string) => {
      await saveFile(name, dest);
    });

  auth
    .command('relogin <name>')
    .description('Delete an existing auth file and prompt to log in again with the same provider.')
    .action(async (name: string) => {
      await reloginFile(name);
    });
}
