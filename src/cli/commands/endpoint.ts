import { Command } from 'commander';
import chalk from 'chalk';
import { authFilesApi } from '@/services/api/authFiles';
import { inferProvider } from '@/utils/lbState';
import { getCachedCliConfig } from '../state/bootstrap';
import { makeTable } from '../ui/tables';

interface EndpointRow {
  provider: string;
  path: string;
  protocol: string;
  isolation: 'isolated' | 'dispatched';
  notes: string;
}

const ROWS: EndpointRow[] = [
  {
    provider: 'codex',
    path: '/backend-api/codex/responses',
    protocol: 'OpenAI Responses (Codex CLI compat)',
    isolation: 'isolated',
    notes: 'Locked to Codex auths via handler type.',
  },
  {
    provider: 'codex',
    path: '/v1/responses',
    protocol: 'OpenAI Responses',
    isolation: 'isolated',
    notes: 'Same handler as above; alternate path.',
  },
  {
    provider: 'anthropic',
    path: '/v1/messages',
    protocol: 'Anthropic Messages',
    isolation: 'isolated',
    notes: 'Locked to Claude/Anthropic auths.',
  },
  {
    provider: 'gemini',
    path: '/v1beta/models/<MODEL>:<METHOD>',
    protocol: 'Gemini API',
    isolation: 'isolated',
    notes: 'Locked to Gemini auths.',
  },
  {
    provider: 'gemini-cli',
    path: '/v1internal:<METHOD>',
    protocol: 'Gemini CLI internal',
    isolation: 'isolated',
    notes: 'Locked to gemini-cli auths.',
  },
  {
    provider: 'mixed',
    path: '/v1/chat/completions',
    protocol: 'OpenAI Chat',
    isolation: 'dispatched',
    notes: 'Routed to whichever auth pool covers the requested model.',
  },
  {
    provider: 'mixed',
    path: '/v1/completions',
    protocol: 'OpenAI Completions (legacy)',
    isolation: 'dispatched',
    notes: 'Same dispatch as /v1/chat/completions.',
  },
];

function badgeForIsolation(isolation: EndpointRow['isolation']): string {
  return isolation === 'isolated' ? chalk.green('isolated') : chalk.yellow('dispatched');
}

function buildBaseUrl(): string {
  const cfg = getCachedCliConfig();
  const raw = (cfg.apiBase ?? 'http://localhost:8317').trim();
  return raw.replace(/\/$/, '');
}

function endpointUrl(row: EndpointRow): string {
  return `${buildBaseUrl()}${row.path}`;
}

function pickPreferredFor(provider: string): EndpointRow | null {
  const target = provider.trim().toLowerCase();
  for (const row of ROWS) {
    if (row.isolation !== 'isolated') continue;
    if (row.provider === target) return row;
  }
  return null;
}

async function listEndpoints(asJson: boolean): Promise<void> {
  const baseUrl = buildBaseUrl();

  // Surface which providers actually have credentials, to mark stale rows.
  let providersWithAuth = new Set<string>();
  try {
    const listing = await authFilesApi.list();
    for (const file of listing.files ?? []) {
      providersWithAuth.add(inferProvider(file).toLowerCase());
    }
  } catch {
    // Best-effort: we still print the routing table, just without the indicator.
    providersWithAuth = new Set<string>();
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          base_url: baseUrl,
          api_key_scoping: 'unsupported',
          endpoints: ROWS.map((row) => ({
            provider: row.provider,
            url: endpointUrl(row),
            protocol: row.protocol,
            isolation: row.isolation,
            notes: row.notes,
            has_auth: row.provider === 'mixed' ? null : providersWithAuth.has(row.provider),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(chalk.bold(`Local endpoints  —  base ${chalk.cyan(baseUrl)}`));
  console.log();

  const table = makeTable(['Provider', 'Path', 'Protocol', 'Isolation', 'Has auth']);
  for (const row of ROWS) {
    const hasAuth =
      row.provider === 'mixed'
        ? chalk.dim('—')
        : providersWithAuth.has(row.provider)
          ? chalk.green('yes')
          : chalk.dim('no');
    table.push([row.provider, row.path, row.protocol, badgeForIsolation(row.isolation), hasAuth]);
  }
  console.log(table.toString());

  console.log(
    chalk.dim(
      `\nIsolation source: backend handler type (Anthropic-only on /v1/messages, Codex-only on /v1/responses, etc.).`
    )
  );
  console.log(
    chalk.dim(
      `API key scoping: NOT supported by the backend today. All proxy api-keys grant access to every endpoint above.`
    )
  );
  console.log(
    chalk.dim(
      `Need hard isolation (separate process per provider)?  Run \`cpa endpoint plan\`.`
    )
  );
}

async function showEndpointUrl(provider: string, opts: { clientConfig?: boolean }): Promise<void> {
  const row = pickPreferredFor(provider);
  if (!row) {
    console.error(
      chalk.red(`Unknown provider "${provider}".`),
      `Use one of: codex, anthropic, gemini, gemini-cli.`
    );
    process.exitCode = 2;
    return;
  }
  const url = endpointUrl(row);

  if (!opts.clientConfig) {
    console.log(url);
    return;
  }

  const baseUrl = buildBaseUrl();
  console.log(chalk.bold(`# ${provider} client config (paste into your shell / .env)`));
  switch (row.provider) {
    case 'anthropic':
      console.log(`ANTHROPIC_BASE_URL=${baseUrl}`);
      console.log(`ANTHROPIC_API_KEY=<your-cpa-apikey>`);
      console.log(chalk.dim(`# Endpoint: ${url}`));
      break;
    case 'codex':
      console.log(`OPENAI_BASE_URL=${baseUrl}/v1`);
      console.log(`OPENAI_API_KEY=<your-cpa-apikey>`);
      console.log(chalk.dim(`# Codex CLI alternate: chatgpt_base_url=${baseUrl}/backend-api/codex`));
      break;
    case 'gemini':
      console.log(`# Use ${url} (Gemini SDKs read GOOGLE_API_KEY / GEMINI_API_KEY)`);
      console.log(`GEMINI_API_KEY=<your-cpa-apikey>`);
      break;
    case 'gemini-cli':
      console.log(`# gemini-cli internal: ${url}`);
      console.log(`GEMINI_API_KEY=<your-cpa-apikey>`);
      break;
  }
}

function printPlan(): void {
  const baseUrl = buildBaseUrl();
  console.log(chalk.bold('Hard-isolation plan (multi-instance)'));
  console.log(`Current single-instance mode: ${chalk.cyan(baseUrl)}  (all auths share one backend).`);
  console.log();
  console.log(`To run one backend instance per provider:`);
  console.log();
  console.log(`  1. Make a per-provider auth dir + config, e.g.:`);
  console.log(chalk.dim(`     ~/.config/cpa/instances/codex/auth/    ~/.config/cpa/instances/codex/config.yaml`));
  console.log(chalk.dim(`     ~/.config/cpa/instances/anthropic/auth/   ~/.config/cpa/instances/anthropic/config.yaml`));
  console.log();
  console.log(`  2. In each config.yaml, set distinct ports and an isolated auth-files dir, e.g.:`);
  console.log(chalk.dim(`        port: 8400               # codex instance`));
  console.log(chalk.dim(`        auth-dir: ~/.config/cpa/instances/codex/auth`));
  console.log(chalk.dim(`        api-keys: [<key-for-codex-clients>]`));
  console.log();
  console.log(`  3. Move only Codex auth files into ${chalk.dim('~/.config/cpa/instances/codex/auth')},`);
  console.log(`     Anthropic ones into the anthropic dir, etc.`);
  console.log();
  console.log(`  4. Start each backend with its own config:`);
  console.log(chalk.dim(`        cliproxyapi --config ~/.config/cpa/instances/codex/config.yaml`));
  console.log();
  console.log(
    `Once each backend is up, point each client at the matching port. Run \`cpa connect --url <url>\``
  );
  console.log(
    `to flip this CLI between instances; the management key is per-instance just like the api-keys.`
  );
}

export function registerEndpointCommand(program: Command): void {
  const endpoint = program
    .command('endpoint')
    .description('Inspect provider-specific local endpoints exposed by the backend.');

  endpoint
    .command('ls')
    .description('List per-provider endpoint paths and which ones isolate by handler type.')
    .option('--json', 'Output JSON instead of a table.')
    .action(async (opts: { json?: boolean }) => {
      await listEndpoints(Boolean(opts.json));
    });

  endpoint
    .command('url <provider>')
    .description(
      'Print the most-specific local URL for one of: codex, anthropic, gemini, gemini-cli.'
    )
    .option('--client-config', 'Print env-var snippet ready to paste into client tooling.')
    .action(async (provider: string, opts: { clientConfig?: boolean }) => {
      await showEndpointUrl(provider, opts);
    });

  endpoint
    .command('plan')
    .description('Print a recipe for running one backend instance per provider (hard isolation).')
    .action(() => {
      printPlan();
    });
}
