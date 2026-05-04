import { Command } from 'commander';
import chalk from 'chalk';
import { apiClient } from '@/services/api/client';
import { normalizeApiBase } from '@/utils/connection';
import { versionApi } from '@/services/api/version';
import { saveCliConfig, loadCliConfig, getDefaultApiBase, CONFIG_PATH } from '../state/configStore';
import { startSpinner } from '../ui/spinner';

export function registerConnectCommand(program: Command): void {
  program
    .command('connect')
    .description('Configure the CLIProxyAPI server URL and management key (saved locally).')
    .option('-u, --url <url>', `Server URL (default: ${getDefaultApiBase()})`)
    .option('-k, --key <key>', 'Management key (Bearer token).')
    .option('--show', 'Print the currently saved config without modifying it.')
    .option('--clear', 'Wipe saved credentials.')
    .action(async (opts: { url?: string; key?: string; show?: boolean; clear?: boolean }) => {
      if (opts.show) {
        const cfg = await loadCliConfig();
        console.log(chalk.bold('Config file:'), CONFIG_PATH);
        console.log(chalk.bold('apiBase:    '), cfg.apiBase ?? chalk.dim('(unset)'));
        console.log(
          chalk.bold('managementKey:'),
          cfg.managementKey ? chalk.green('(set)') : chalk.dim('(unset)')
        );
        return;
      }

      if (opts.clear) {
        await saveCliConfig({ apiBase: undefined, managementKey: undefined });
        console.log(chalk.green('Cleared.'));
        return;
      }

      const current = await loadCliConfig();
      const apiBase = normalizeApiBase(opts.url ?? current.apiBase ?? getDefaultApiBase());
      const managementKey = (opts.key ?? current.managementKey ?? '').trim();

      if (!managementKey) {
        console.error(chalk.red('Missing management key. Pass --key <key>.'));
        process.exitCode = 2;
        return;
      }

      apiClient.setConfig({ apiBase, managementKey });
      const spinner = startSpinner(`Probing ${apiBase} ...`);
      try {
        await versionApi.checkLatest();
        spinner.succeed('Connected.');
      } catch (err) {
        spinner.fail(`Connection failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      await saveCliConfig({ apiBase, managementKey });
      console.log(chalk.green(`Saved to ${CONFIG_PATH}`));
    });
}
