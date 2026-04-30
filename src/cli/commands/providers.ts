import { Command } from 'commander';
import chalk from 'chalk';
import { providersApi } from '@/services/api/providers';
import type {
  GeminiKeyConfig,
  ModelAlias,
  OpenAIProviderConfig,
  ProviderKeyConfig,
} from '@/types';
import { makeTable, maskedKeyTail } from '../ui/tables';

type ProviderKind = 'gemini' | 'codex' | 'claude' | 'vertex' | 'openai';
const PROVIDER_KINDS: ProviderKind[] = ['gemini', 'codex', 'claude', 'vertex', 'openai'];

const isProviderKind = (value: string): value is ProviderKind =>
  (PROVIDER_KINDS as string[]).includes(value);

interface KeyedProviderEntry {
  apiKey: string;
  baseUrl?: string;
  models?: ModelAlias[];
  priority?: number;
  prefix?: string;
}

async function listProvider(kind: ProviderKind): Promise<void> {
  if (kind === 'openai') {
    const list = await providersApi.getOpenAIProviders();
    if (!list.length) {
      console.log(chalk.dim('No OpenAI-compatible providers configured.'));
      return;
    }
    console.log(chalk.bold(`OpenAI-compatible providers (${list.length})`));
    list.forEach((provider, idx) => printOpenAIProvider(idx, provider));
    return;
  }

  const list = await fetchKeyConfigs(kind);
  if (!list.length) {
    console.log(chalk.dim(`No ${kind} keys configured.`));
    return;
  }
  console.log(chalk.bold(`${kind} keys (${list.length})`));
  const table = makeTable(['#', 'Key', 'Base URL', 'Models', 'Priority']);
  list.forEach((entry, idx) => {
    table.push([
      String(idx),
      maskedKeyTail(entry.apiKey),
      entry.baseUrl ?? chalk.dim('—'),
      String(entry.models?.length ?? 0),
      entry.priority !== undefined ? String(entry.priority) : chalk.dim('—'),
    ]);
  });
  console.log(table.toString());
}

function printOpenAIProvider(idx: number, provider: OpenAIProviderConfig): void {
  console.log(`\n${chalk.bold(`#${idx}`)} ${chalk.cyan(provider.name)}`);
  console.log(`  base-url   ${provider.baseUrl}`);
  console.log(
    `  api-keys   ${provider.apiKeyEntries.length} (${provider.apiKeyEntries
      .map((e) => maskedKeyTail(e.apiKey))
      .join(', ') || chalk.dim('none')})`
  );
  if (provider.models?.length) {
    console.log(`  models     ${provider.models.length} (${formatModelList(provider.models)})`);
  } else {
    console.log(`  models     ${chalk.dim('none')}`);
  }
}

function formatModelList(models: ModelAlias[]): string {
  return models
    .map((m) => (m.alias && m.alias !== m.name ? `${m.name}→${m.alias}` : m.name))
    .join(', ');
}

async function fetchKeyConfigs(
  kind: Exclude<ProviderKind, 'openai'>
): Promise<KeyedProviderEntry[]> {
  switch (kind) {
    case 'gemini': {
      const list = await providersApi.getGeminiKeys();
      return list.map(toKeyedEntry);
    }
    case 'codex': {
      const list = await providersApi.getCodexConfigs();
      return list.map(toKeyedEntry);
    }
    case 'claude': {
      const list = await providersApi.getClaudeConfigs();
      return list.map(toKeyedEntry);
    }
    case 'vertex': {
      const list = await providersApi.getVertexConfigs();
      return list.map(toKeyedEntry);
    }
  }
}

function toKeyedEntry(value: ProviderKeyConfig | GeminiKeyConfig): KeyedProviderEntry {
  return {
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
    models: value.models,
    priority: value.priority,
    prefix: value.prefix,
  };
}

async function patchProviderEntry(
  kind: Exclude<ProviderKind, 'openai'>,
  index: number,
  mutate: (entry: ProviderKeyConfig | GeminiKeyConfig) => void
): Promise<void> {
  if (kind === 'gemini') {
    const list = await providersApi.getGeminiKeys();
    const entry = list[index];
    if (!entry) throw new Error(`No gemini entry at index ${index}.`);
    mutate(entry);
    await providersApi.updateGeminiKey(index, entry);
    return;
  }
  const list =
    kind === 'codex'
      ? await providersApi.getCodexConfigs()
      : kind === 'claude'
        ? await providersApi.getClaudeConfigs()
        : await providersApi.getVertexConfigs();
  const entry = list[index];
  if (!entry) throw new Error(`No ${kind} entry at index ${index}.`);
  mutate(entry);
  if (kind === 'codex') await providersApi.updateCodexConfig(index, entry);
  else if (kind === 'claude') await providersApi.updateClaudeConfig(index, entry);
  else await providersApi.updateVertexConfig(index, entry);
}

async function patchOpenAIProvider(
  index: number,
  mutate: (provider: OpenAIProviderConfig) => void
): Promise<void> {
  const list = await providersApi.getOpenAIProviders();
  const entry = list[index];
  if (!entry) throw new Error(`No openai-compatibility entry at index ${index}.`);
  mutate(entry);
  await providersApi.updateOpenAIProvider(index, entry);
}

interface AddModelOpts {
  alias?: string;
  priority?: number;
  testModel?: string;
}

function appendOrReplaceModel(
  models: ModelAlias[] | undefined,
  model: string,
  opts: AddModelOpts
): ModelAlias[] {
  const next = [...(models ?? [])];
  const idx = next.findIndex((m) => m.name === model);
  const entry: ModelAlias = { name: model };
  if (opts.alias) entry.alias = opts.alias;
  if (opts.priority !== undefined) entry.priority = opts.priority;
  if (opts.testModel) entry.testModel = opts.testModel;
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return next;
}

function removeModel(models: ModelAlias[] | undefined, model: string): ModelAlias[] {
  return (models ?? []).filter((m) => m.name !== model);
}

async function addModel(
  kind: ProviderKind,
  index: number,
  model: string,
  opts: AddModelOpts
): Promise<void> {
  if (kind === 'openai') {
    await patchOpenAIProvider(index, (provider) => {
      provider.models = appendOrReplaceModel(provider.models, model, opts);
    });
  } else {
    await patchProviderEntry(kind, index, (entry) => {
      entry.models = appendOrReplaceModel(entry.models, model, opts);
    });
  }
  console.log(chalk.green(`Added model "${model}" to ${kind}#${index}.`));
}

async function removeModelFrom(
  kind: ProviderKind,
  index: number,
  model: string
): Promise<void> {
  if (kind === 'openai') {
    await patchOpenAIProvider(index, (provider) => {
      provider.models = removeModel(provider.models, model);
    });
  } else {
    await patchProviderEntry(kind, index, (entry) => {
      entry.models = removeModel(entry.models, model);
    });
  }
  console.log(chalk.green(`Removed model "${model}" from ${kind}#${index}.`));
}

function ensureProviderKind(value: string): ProviderKind {
  const lower = value.toLowerCase();
  if (!isProviderKind(lower)) {
    throw new Error(`Unknown provider "${value}". Try one of: ${PROVIDER_KINDS.join(', ')}.`);
  }
  return lower;
}

export function registerProvidersCommand(program: Command): void {
  const providers = program
    .command('providers')
    .description(`Manage provider keys + model aliases. Providers: ${PROVIDER_KINDS.join(', ')}.`);

  providers
    .command('ls [provider]')
    .description('List configured provider keys (all providers if omitted).')
    .action(async (provider?: string) => {
      if (provider) {
        await listProvider(ensureProviderKind(provider));
        return;
      }
      for (const kind of PROVIDER_KINDS) {
        await listProvider(kind);
        console.log('');
      }
    });

  providers
    .command('add-model <provider> <index> <model>')
    .description('Add or update a model alias on a provider key entry.')
    .option('-a, --alias <alias>', 'Public alias the model is exposed as.')
    .option('-p, --priority <n>', 'Priority weight.', (v) => Number(v))
    .option('-t, --test-model <name>', 'Override the connectivity-test model.')
    .action(
      async (
        provider: string,
        index: string,
        model: string,
        opts: { alias?: string; priority?: number; testModel?: string }
      ) => {
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0) throw new Error(`Index must be a non-negative integer.`);
        await addModel(ensureProviderKind(provider), idx, model, opts);
      }
    );

  providers
    .command('rm-model <provider> <index> <model>')
    .description('Remove a model alias from a provider key entry.')
    .action(async (provider: string, index: string, model: string) => {
      const idx = Number(index);
      if (!Number.isInteger(idx) || idx < 0) throw new Error(`Index must be a non-negative integer.`);
      await removeModelFrom(ensureProviderKind(provider), idx, model);
    });
}
