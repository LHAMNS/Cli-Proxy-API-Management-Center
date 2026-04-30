import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { parse as parseYaml } from 'yaml';
import { configApi } from '@/services/api/config';
import { configFileApi } from '@/services/api/configFile';

type ConfigSetter =
  | { kind: 'bool'; call: (v: boolean) => Promise<unknown> }
  | { kind: 'string'; call: (v: string) => Promise<unknown> }
  | { kind: 'number'; call: (v: number) => Promise<unknown> };

const SETTERS: Record<string, ConfigSetter> = {
  debug: { kind: 'bool', call: (v) => configApi.updateDebug(v) },
  'request-log': { kind: 'bool', call: (v) => configApi.updateRequestLog(v) },
  'logging-to-file': { kind: 'bool', call: (v) => configApi.updateLoggingToFile(v) },
  'usage-statistics-enabled': { kind: 'bool', call: (v) => configApi.updateUsageStatistics(v) },
  'force-model-prefix': { kind: 'bool', call: (v) => configApi.updateForceModelPrefix(v) },
  'ws-auth': { kind: 'bool', call: (v) => configApi.updateWsAuth(v) },
  'quota-exceeded.switch-project': {
    kind: 'bool',
    call: (v) => configApi.updateSwitchProject(v),
  },
  'quota-exceeded.switch-preview-model': {
    kind: 'bool',
    call: (v) => configApi.updateSwitchPreviewModel(v),
  },
  'proxy-url': { kind: 'string', call: (v) => configApi.updateProxyUrl(v) },
  'routing.strategy': { kind: 'string', call: (v) => configApi.updateRoutingStrategy(v) },
  'request-retry': { kind: 'number', call: (v) => configApi.updateRequestRetry(v) },
  'logs-max-total-size-mb': {
    kind: 'number',
    call: (v) => configApi.updateLogsMaxTotalSizeMb(v),
  },
};

const GETTERS: Record<string, () => Promise<unknown>> = {
  'logs-max-total-size-mb': () => configApi.getLogsMaxTotalSizeMb(),
  'force-model-prefix': () => configApi.getForceModelPrefix(),
  'routing.strategy': () => configApi.getRoutingStrategy(),
};

function parseBool(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lower)) return true;
  if (['false', '0', 'no', 'off'].includes(lower)) return false;
  throw new Error(`Expected boolean (true/false), got "${value}".`);
}

function getNested(obj: unknown, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, obj);
}

async function getConfig(key?: string, full?: boolean): Promise<void> {
  if (!key && !full) {
    const yamlText = await configFileApi.fetchConfigYaml();
    process.stdout.write(yamlText);
    if (!yamlText.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  if (key && GETTERS[key]) {
    const value = await GETTERS[key]();
    console.log(value);
    return;
  }

  if (key) {
    const yamlText = await configFileApi.fetchConfigYaml();
    const parsed = parseYaml(yamlText) as unknown;
    const value = getNested(parsed, key);
    if (value === undefined) {
      console.error(chalk.yellow(`Key "${key}" not found in config.`));
      process.exitCode = 1;
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      console.log(value);
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
    return;
  }

  // --full
  const yamlText = await configFileApi.fetchConfigYaml();
  process.stdout.write(yamlText);
  if (!yamlText.endsWith('\n')) process.stdout.write('\n');
}

async function setConfig(key: string, rawValue: string): Promise<void> {
  const setter = SETTERS[key];
  if (!setter) {
    console.error(
      chalk.red(`No fast setter for "${key}".`),
      `Use \`cpa config edit\` for arbitrary YAML changes.\n`,
      `Supported keys: ${Object.keys(SETTERS).sort().join(', ')}`
    );
    process.exitCode = 2;
    return;
  }

  try {
    if (setter.kind === 'bool') {
      await setter.call(parseBool(rawValue));
    } else if (setter.kind === 'number') {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) throw new Error(`Expected number, got "${rawValue}".`);
      await setter.call(num);
    } else {
      await setter.call(rawValue);
    }
    console.log(chalk.green(`Set ${key} = ${rawValue}.`));
  } catch (err) {
    console.error(chalk.red(`Failed: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}

async function editConfig(): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
  const yamlText = await configFileApi.fetchConfigYaml();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-config-'));
  const tmpFile = path.join(tmpDir, 'config.yaml');
  await fs.writeFile(tmpFile, yamlText, 'utf8');

  console.log(chalk.dim(`Opening ${editor} on ${tmpFile}...`));

  const result = await new Promise<number>((resolve, reject) => {
    const child = spawn(editor, [tmpFile], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', reject);
  });

  if (result !== 0) {
    console.error(chalk.yellow(`Editor exited with code ${result}; aborting save.`));
    await fs.rm(tmpDir, { recursive: true, force: true });
    process.exitCode = result;
    return;
  }

  const updated = await fs.readFile(tmpFile, 'utf8');
  if (updated === yamlText) {
    console.log(chalk.dim('No changes.'));
    await fs.rm(tmpDir, { recursive: true, force: true });
    return;
  }

  // Sanity-parse before sending so we don't ship invalid YAML to the server.
  try {
    parseYaml(updated);
  } catch (err) {
    console.error(chalk.red(`Refused to save: invalid YAML — ${(err as Error).message}`));
    console.error(chalk.dim(`Edits preserved at ${tmpFile} so you can fix and try again.`));
    process.exitCode = 1;
    return;
  }

  await configFileApi.saveConfigYaml(updated);
  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(chalk.green('Saved.'));
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Inspect and edit the server config.yaml.');

  config
    .command('get [key]')
    .description(
      'Print the full YAML, or a single key (dotted path supported, e.g. "routing.strategy").'
    )
    .option('--full', 'Force full YAML even when [key] is supplied.')
    .action(async (key: string | undefined, opts: { full?: boolean }) => {
      await getConfig(key, Boolean(opts.full));
    });

  config
    .command('set <key> <value>')
    .description(
      `Set a known field via dedicated endpoint. Supported keys:\n  ${Object.keys(SETTERS)
        .sort()
        .join(', ')}`
    )
    .action(async (key: string, value: string) => {
      await setConfig(key, value);
    });

  config
    .command('edit')
    .description('Open the YAML in $EDITOR (or nano), then save back to the server.')
    .action(async () => {
      await editConfig();
    });
}
