import { Command } from 'commander';
import chalk from 'chalk';
import readline from 'node:readline';
import { oauthApi, type OAuthProvider } from '@/services/api/oauth';
import { authFilesApi } from '@/services/api/authFiles';
import { isWsl, openUrl } from '../ui/browser';
import { startSpinner } from '../ui/spinner';

const SUPPORTED_PROVIDERS = ['codex', 'anthropic', 'antigravity', 'gemini-cli'] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const isSupportedProvider = (value: string): value is SupportedProvider =>
  (SUPPORTED_PROVIDERS as readonly string[]).includes(value);

/**
 * Convert whatever the user pasted (a full URL, a bare code, or `code#state`
 * which Claude/Anthropic-style flows show on the success page) into a
 * synthetic redirect URL the backend's /oauth-callback can parse.
 *
 * Returns null if the input is empty.
 */
function buildSyntheticRedirect(input: string, fallbackState: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already a full URL — pass through. Backend extracts code+state from query.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // Try to detect "code#state" (Claude/Anthropic display format) or "code/state".
  let code = trimmed;
  let state = fallbackState;

  if (trimmed.includes('#')) {
    const [c, s] = trimmed.split('#', 2);
    code = c.trim();
    if (s?.trim()) state = s.trim();
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const [c, s] = trimmed.split('/', 2);
    code = c.trim();
    state = s.trim();
  }

  if (!code) return null;

  const url = new URL('http://localhost/oauth/callback');
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}

interface RaceOutcome {
  kind: 'ok' | 'cancelled' | 'timeout' | 'error';
  message?: string;
  via?: 'poll' | 'paste';
}

/**
 * Run polling and a paste-prompt concurrently. First to succeed wins; the
 * other is cancelled via AbortController. This is the core fix for WSL where
 * the provider's auto-redirect to `localhost:<port>` often can't reach the
 * backend, so the user can paste the URL manually at any time without
 * waiting for the poll to time out.
 */
async function awaitAuthCallback(
  provider: SupportedProvider,
  state: string,
  pollTimeoutMs: number
): Promise<RaceOutcome> {
  const ac = new AbortController();
  let outcome: RaceOutcome = { kind: 'cancelled' };
  let resolved = false;

  const finish = (next: RaceOutcome) => {
    if (resolved) return;
    resolved = true;
    outcome = next;
    ac.abort();
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      ac.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });

  const pollTask = (async () => {
    const deadline = Date.now() + pollTimeoutMs;
    while (!resolved && Date.now() < deadline) {
      try {
        const res = await oauthApi.getAuthStatus(state);
        if (res.status === 'ok') return finish({ kind: 'ok', via: 'poll' });
        if (res.status === 'error') {
          return finish({ kind: 'error', message: res.error, via: 'poll' });
        }
      } catch {
        // Network blip — keep retrying silently.
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!resolved) finish({ kind: 'timeout', via: 'poll' });
  })();

  const manualTask = (async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const onAbort = () => rl.close();
    ac.signal.addEventListener('abort', onAbort, { once: true });

    let answer: string | null = null;
    try {
      answer = await new Promise<string>((resolve, reject) => {
        rl.question(
          chalk.dim('  Paste redirect URL (or press Enter to wait silently): '),
          resolve
        );
        rl.once('close', () => reject(new Error('rl-closed')));
      });
    } catch {
      // rl was closed because polling won. Done.
      return;
    } finally {
      ac.signal.removeEventListener('abort', onAbort);
      rl.close();
    }

    if (resolved) return;
    const synthetic = buildSyntheticRedirect(answer ?? '', state);
    if (!synthetic) {
      // User pressed Enter empty → fall through to silent polling.
      console.log(chalk.dim('  Polling silently for browser callback…'));
      return;
    }

    try {
      await oauthApi.submitCallback(provider, synthetic);
      finish({ kind: 'ok', via: 'paste' });
    } catch (err) {
      finish({ kind: 'error', message: (err as Error).message, via: 'paste' });
    }
  })();

  await Promise.allSettled([pollTask, manualTask]);
  return outcome;
}

async function manualOnlyCallback(
  provider: SupportedProvider,
  state: string
): Promise<RaceOutcome> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      chalk.cyan('Paste the redirect URL OR just the code (or code#state): '),
      resolve
    );
  });
  rl.close();
  const synthetic = buildSyntheticRedirect(answer, state);
  if (!synthetic) return { kind: 'cancelled' };

  try {
    await oauthApi.submitCallback(provider, synthetic);
    return { kind: 'ok', via: 'paste' };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message, via: 'paste' };
  }
}

async function findNewestAuthFile(provider: SupportedProvider): Promise<string | null> {
  const prefix = provider === 'gemini-cli' ? 'gemini' : provider;
  try {
    const res = await authFilesApi.list();
    const files = res.files ?? [];
    const matches = files
      .map((f) => String(f?.name ?? ''))
      .filter((name) => name.toLowerCase().startsWith(prefix));
    matches.sort();
    return matches.length ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

function printWslHint(): void {
  console.log(
    chalk.yellow(
      'WSL detected. The OAuth provider may redirect your browser to a localhost\n' +
        '  URL that can\'t reach the backend inside WSL. If you see "site can\'t be\n' +
        '  reached" in the browser after authorising, copy the URL it tried to visit\n' +
        '  and paste it below — that completes the login through the management API.'
    )
  );
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login <provider>')
    .description(
      `OAuth login for one of: ${SUPPORTED_PROVIDERS.join(', ')}. Opens the system browser ` +
        `and races auto-poll with a paste prompt — whichever completes first wins.`
    )
    .option(
      '-p, --project-id <id>',
      'gemini-cli only: GCP project ID, or "ALL" for every project.'
    )
    .option('--manual', 'Skip auto-poll; only prompt for a pasted redirect URL.')
    .option(
      '--code <code>',
      'Submit a known code (or code#state) directly without opening the browser. Useful when you already authenticated and just need to finish the exchange.'
    )
    .option(
      '--timeout <seconds>',
      'How long the auto-poll keeps trying before timing out.',
      (v) => Number(v),
      DEFAULT_POLL_TIMEOUT_MS / 1000
    )
    .action(
      async (
        providerArg: string,
        opts: { projectId?: string; manual?: boolean; code?: string; timeout?: number }
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

        // --code <code>: skip browser entirely. We still need a state from
        // the backend (otherwise it'll reject the callback), so we call
        // startAuth to register one before submitting.
        if (opts.code) {
          const startSpin = startSpinner('Registering auth state…');
          let state: string | undefined;
          try {
            const res = await oauthApi.startAuth(
              provider as OAuthProvider,
              provider === 'gemini-cli' ? { projectId: opts.projectId } : undefined
            );
            state = res.state;
            startSpin.succeed('State registered.');
          } catch (err) {
            startSpin.fail(`Could not register state: ${(err as Error).message}`);
            process.exitCode = 1;
            return;
          }
          if (!state) {
            console.error(chalk.red('Server did not return a state token; cannot use --code.'));
            process.exitCode = 1;
            return;
          }
          const synthetic = buildSyntheticRedirect(opts.code, state);
          if (!synthetic) {
            console.error(chalk.red('Empty --code value.'));
            process.exitCode = 2;
            return;
          }
          try {
            await oauthApi.submitCallback(provider as OAuthProvider, synthetic);
            console.log(chalk.green('✔ Authorised (direct --code).'));
          } catch (err) {
            console.error(chalk.red(`Submit failed: ${(err as Error).message}`));
            process.exitCode = 1;
            return;
          }
          const newest = await findNewestAuthFile(provider);
          if (newest) console.log(`${chalk.green('●')} New auth file:  ${chalk.bold(newest)}`);
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

        if (await isWsl()) {
          printWslHint();
        }

        let outcome: RaceOutcome;
        if (opts.manual || !state) {
          outcome = await manualOnlyCallback(provider, state ?? '');
        } else {
          const timeoutMs = Math.max(
            10_000,
            (opts.timeout ?? DEFAULT_POLL_TIMEOUT_MS / 1000) * 1000
          );
          outcome = await awaitAuthCallback(provider, state, timeoutMs);
        }

        switch (outcome.kind) {
          case 'ok': {
            const via = outcome.via === 'paste' ? 'manual paste' : 'auto-callback';
            console.log(chalk.green(`✔ Authorised (${via}).`));
            break;
          }
          case 'timeout': {
            console.error(
              chalk.red(`Timed out waiting for browser callback.`),
              `Re-run with \`cpa login ${provider} --manual\` to paste the URL directly.`
            );
            process.exitCode = 1;
            return;
          }
          case 'error': {
            console.error(chalk.red(`Auth failed: ${outcome.message ?? 'unknown error'}`));
            process.exitCode = 1;
            return;
          }
          case 'cancelled': {
            console.error(chalk.yellow('Cancelled.'));
            process.exitCode = 1;
            return;
          }
        }

        const newest = await findNewestAuthFile(provider);
        if (newest) {
          console.log(`${chalk.green('●')} New auth file:  ${chalk.bold(newest)}`);
          console.log(
            chalk.dim('  Use `cpa auth ls` to inspect, `cpa auth rm <name>` to remove.')
          );
        } else {
          console.log(chalk.dim('Auth file written; run `cpa auth ls` to confirm.'));
        }
      }
    );
}
