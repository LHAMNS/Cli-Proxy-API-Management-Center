import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { oauthApi, type OAuthProvider } from '@/services/api/oauth';
import { authFilesApi } from '@/services/api/authFiles';
import { openUrl } from '../ui/browser';
import { startSpinner } from '../ui/spinner';

const SUPPORTED_PROVIDERS = ['codex', 'anthropic', 'antigravity', 'gemini-cli'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const isSupportedProvider = (value: string): value is SupportedProvider =>
  (SUPPORTED_PROVIDERS as readonly string[]).includes(value);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function pollUntilDone(state: string): Promise<'ok' | 'error' | 'timeout'> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await oauthApi.getAuthStatus(state);
      if (res.status === 'ok') return 'ok';
      if (res.status === 'error') {
        throw new Error(res.error || 'Provider returned error.');
      }
    } catch (err) {
      throw err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return 'timeout';
}

async function manualCallback(provider: SupportedProvider): Promise<boolean> {
  const answer = await prompts({
    type: 'text',
    name: 'redirectUrl',
    message: 'Paste the full redirect URL (with ?code=…&state=…):',
  });
  const redirectUrl = String(answer.redirectUrl || '').trim();
  if (!redirectUrl) {
    console.error(chalk.red('No URL entered, aborting.'));
    return false;
  }
  const spinner = startSpinner('Submitting callback…');
  try {
    await oauthApi.submitCallback(provider, redirectUrl);
    spinner.succeed('Callback accepted.');
    return true;
  } catch (err) {
    spinner.fail(`Callback rejected: ${(err as Error).message}`);
    return false;
  }
}

async function findNewestAuthFile(provider: SupportedProvider): Promise<string | null> {
  const prefix = provider === 'gemini-cli' ? 'gemini' : provider;
  try {
    const res = await authFilesApi.list();
    const files = (res.files ?? []) as Array<{ name?: string }>;
    const matches = files
      .map((f) => String(f?.name ?? ''))
      .filter((name) => name.toLowerCase().startsWith(prefix));
    matches.sort();
    return matches.length ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login <provider>')
    .description(
      `OAuth login for one of: ${SUPPORTED_PROVIDERS.join(', ')}. Opens the system browser.`
    )
    .option('-p, --project-id <id>', 'gemini-cli only: GCP project ID, or "ALL" for every project.')
    .option('--manual', 'Skip auto-poll; paste the redirect URL manually instead.')
    .action(
      async (
        providerArg: string,
        opts: { projectId?: string; manual?: boolean }
      ) => {
        const provider = providerArg.toLowerCase();
        if (!isSupportedProvider(provider)) {
          console.error(
            chalk.red(`Unsupported provider "${providerArg}".`),
            `Try one of: ${SUPPORTED_PROVIDERS.join(', ')}.`
          );
          process.exitCode = 2;
          return;
        }

        const startSpin = startSpinner(`Requesting auth URL from server…`);
        let url: string;
        let state: string | undefined;
        try {
          const res = await oauthApi.startAuth(
            provider as OAuthProvider,
            provider === 'gemini-cli' ? { projectId: opts.projectId } : undefined
          );
          url = res.url;
          state = res.state;
          startSpin.succeed('Auth URL received.');
        } catch (err) {
          startSpin.fail(`Failed: ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }

        await openUrl(url);

        if (opts.manual || !state) {
          const ok = await manualCallback(provider);
          if (!ok) {
            process.exitCode = 1;
            return;
          }
        } else {
          const spinner = startSpinner('Waiting for browser callback (5 min)…');
          try {
            const result = await pollUntilDone(state);
            if (result === 'ok') {
              spinner.succeed('Authorized.');
            } else {
              spinner.warn('Timed out. You can paste the redirect URL manually.');
              const ok = await manualCallback(provider);
              if (!ok) {
                process.exitCode = 1;
                return;
              }
            }
          } catch (err) {
            spinner.fail(`Auth failed: ${(err as Error).message}`);
            process.exitCode = 1;
            return;
          }
        }

        const newest = await findNewestAuthFile(provider);
        if (newest) {
          console.log(`${chalk.green('●')} New auth file:  ${chalk.bold(newest)}`);
          console.log(chalk.dim('  Use `cpa auth ls` to inspect, `cpa auth rm <name>` to remove.'));
        } else {
          console.log(chalk.dim('Auth file written; run `cpa auth ls` to confirm.'));
        }
      }
    );
}
