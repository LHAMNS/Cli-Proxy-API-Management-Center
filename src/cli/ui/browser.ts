import { promises as fs } from 'node:fs';
import open from 'open';
import spawn from 'cross-spawn';
import chalk from 'chalk';

let cachedIsWsl: boolean | null = null;

export async function isWsl(): Promise<boolean> {
  if (cachedIsWsl !== null) return cachedIsWsl;
  if (process.platform !== 'linux') {
    cachedIsWsl = false;
    return false;
  }
  try {
    const release = await fs.readFile('/proc/version', 'utf8');
    cachedIsWsl = /microsoft/i.test(release);
  } catch {
    cachedIsWsl = false;
  }
  return cachedIsWsl;
}

const trySpawn = (cmd: string, args: string[]): boolean => {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* swallowed; user always has the printed URL fallback */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

/**
 * Opens a URL in the host's default browser.
 *
 * Order of preference:
 * 1. WSL: `cmd.exe /c start <url>` then `wslview <url>`.
 * 2. Other platforms: the `open` package.
 *
 * The user-visible URL is always printed first so they have a copy-paste fallback
 * even if every launch path fails.
 */
export async function openUrl(url: string): Promise<void> {
  console.log(chalk.cyan('Open this URL in your browser:'));
  console.log(`  ${chalk.underline(url)}`);

  if (await isWsl()) {
    if (trySpawn('cmd.exe', ['/c', 'start', '', url])) return;
    if (trySpawn('wslview', [url])) return;
    return;
  }

  try {
    await open(url, { wait: false });
  } catch {
    // already printed the URL — user can open manually
  }
}
