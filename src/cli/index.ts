#!/usr/bin/env bun
import { Command } from 'commander';
import chalk from 'chalk';
import { bootstrap } from './state/bootstrap';
import { registerConnectCommand } from './commands/connect';
import { registerVersionCommand } from './commands/version';
import { registerLoginCommand } from './commands/login';
import { registerAuthCommand } from './commands/auth';
import { registerUsageCommand } from './commands/usage';
import { registerLogsCommand } from './commands/logs';
import { registerConfigCommand } from './commands/config';
import { registerProvidersCommand } from './commands/providers';
import { registerApiKeysCommand } from './commands/apikeys';

const program = new Command();

program
  .name('cpa')
  .description('Local-only CLI for managing the CLIProxyAPI backend.')
  .version('0.1.0');

// Subcommands that don't need a configured key (they bootstrap differently).
const NO_KEY_REQUIRED = new Set(['connect', 'version', 'help']);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const name = actionCommand.name();
  const requireKey = !NO_KEY_REQUIRED.has(name);
  try {
    await bootstrap({ requireKey });
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(2);
  }
});

registerConnectCommand(program);
registerVersionCommand(program);
registerLoginCommand(program);
registerAuthCommand(program);
registerUsageCommand(program);
registerLogsCommand(program);
registerConfigCommand(program);
registerProvidersCommand(program);
registerApiKeysCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const error = err as Error & { code?: string };
  if (error.code === 'UNAUTHORIZED') {
    console.error(chalk.red('401 Unauthorized.'), 'Run `cpa connect --key <key>` to update credentials.');
    process.exit(2);
  }
  console.error(chalk.red(error.message ?? String(err)));
  process.exit(1);
});
