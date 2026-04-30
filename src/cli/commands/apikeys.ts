import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { randomBytes } from 'node:crypto';
import { apiKeysApi } from '@/services/api/apiKeys';
import { makeTable, maskedKeyTail } from '../ui/tables';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateKey(): string {
  // Rejection sampling to avoid modulo bias.
  const out: string[] = [];
  while (out.length < 32) {
    const buf = randomBytes(64);
    for (let i = 0; i < buf.length && out.length < 32; i++) {
      const byte = buf[i];
      const limit = 256 - (256 % ALPHABET.length); // largest multiple of 62 ≤ 256
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return `sk-${out.join('')}`;
}

async function listKeys(): Promise<void> {
  const keys = await apiKeysApi.list();
  if (!keys.length) {
    console.log(chalk.dim('No proxy API keys configured.'));
    return;
  }
  const table = makeTable(['#', 'Key (masked)']);
  keys.forEach((key, idx) => {
    table.push([String(idx), maskedKeyTail(key, 6)]);
  });
  console.log(table.toString());
  console.log(chalk.dim(`Total: ${keys.length}`));
}

async function addKey(provided?: string): Promise<void> {
  const keys = await apiKeysApi.list();
  let value = provided?.trim();
  if (!value) {
    value = generateKey();
    console.log(chalk.green(`Generated:`), value);
  }
  if (keys.includes(value)) {
    console.log(chalk.yellow('Key already exists; skipping.'));
    return;
  }
  await apiKeysApi.replace([...keys, value]);
  console.log(chalk.green('Added.'));
}

async function removeKey(target: string, force: boolean): Promise<void> {
  const keys = await apiKeysApi.list();
  const idx = /^\d+$/.test(target) ? Number(target) : keys.indexOf(target);
  if (idx < 0 || idx >= keys.length) {
    console.error(chalk.red(`No such key: "${target}". Use \`cpa apikeys ls\` to see available indices.`));
    process.exitCode = 2;
    return;
  }
  if (!force) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `Delete key #${idx} (${maskedKeyTail(keys[idx], 6)})?`,
      initial: false,
    });
    if (!confirm.ok) return;
  }
  await apiKeysApi.delete(idx);
  console.log(chalk.green('Removed.'));
}

export function registerApiKeysCommand(program: Command): void {
  const apikeys = program
    .command('apikeys')
    .description('Manage proxy api-keys (downstream client credentials, NOT the management key).');

  apikeys
    .command('ls')
    .description('List proxy api-keys.')
    .action(listKeys);

  apikeys
    .command('add [key]')
    .description('Add a key (generates one if omitted).')
    .action(async (key?: string) => {
      await addKey(key);
    });

  apikeys
    .command('rm <indexOrKey>')
    .description('Delete a key by index (e.g. 0) or full value.')
    .option('-y, --yes', 'Skip confirmation.')
    .action(async (indexOrKey: string, opts: { yes?: boolean }) => {
      await removeKey(indexOrKey, Boolean(opts.yes));
    });
}
