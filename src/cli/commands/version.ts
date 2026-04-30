import { Command } from 'commander';
import chalk from 'chalk';
import { apiClient } from '@/services/api/client';
import { versionApi } from '@/services/api/version';

const CLI_VERSION = '0.1.0';

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Show CLI and server version.')
    .action(async () => {
      console.log(`${chalk.bold('cpa CLI')}      ${CLI_VERSION}`);
      try {
        const data = (await versionApi.checkLatest()) as Record<string, unknown> | null;
        const serverVersion =
          apiClient.getLastServerVersion() ??
          (typeof data?.version === 'string' ? data.version : undefined) ??
          (typeof data?.['latest_version'] === 'string' ? data['latest_version'] : undefined) ??
          null;
        const buildDate =
          apiClient.getLastServerBuildDate() ??
          (typeof data?.['build_date'] === 'string' ? data['build_date'] : undefined) ??
          null;
        if (serverVersion) console.log(`${chalk.bold('server')}       ${serverVersion}`);
        if (buildDate) console.log(`${chalk.bold('built')}        ${buildDate}`);
        if (data && Object.keys(data).length) {
          console.log(chalk.dim(`(raw: ${JSON.stringify(data)})`));
        }
      } catch (err) {
        console.error(chalk.yellow(`Could not reach server: ${(err as Error).message}`));
      }
    });
}
