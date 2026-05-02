import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import spawn from 'cross-spawn';
import axios from 'axios';
import { loadCliConfig, getDefaultApiBase, CONFIG_PATH } from '../state/configStore';
import { isWsl } from '../ui/browser';
import { computeApiUrl, normalizeApiBase } from '@/utils/connection';

interface CheckResult {
  ok: boolean;
  detail: string;
}

const tag = (ok: boolean) => (ok ? chalk.green('✓') : chalk.red('✗'));

async function readWslVersion(): Promise<string | null> {
  try {
    return (await fs.readFile('/proc/version', 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readWslConfig(): Promise<string | null> {
  try {
    const userProfile = await runCmd('cmd.exe', ['/c', 'echo %USERPROFILE%']);
    const winPath = (userProfile ?? '').trim().replace(/\\/g, '/');
    if (!winPath) return null;
    const driveMatch = winPath.match(/^([A-Za-z]):/);
    if (!driveMatch) return null;
    const wslPath = winPath.replace(/^([A-Za-z]):/, `/mnt/${driveMatch[1].toLowerCase()}`);
    return await fs.readFile(`${wslPath}/.wslconfig`, 'utf8');
  } catch {
    return null;
  }
}

function runCmd(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? out : null));
  });
}

async function pingFromWsl(url: string, key: string): Promise<CheckResult> {
  try {
    const res = await axios.get(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      timeout: 3000,
      validateStatus: () => true,
    });
    return { ok: res.status > 0 && res.status < 500, detail: `HTTP ${res.status}` };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, detail: `cannot reach (${code ?? (err as Error).message})` };
  }
}

async function pingFromWindows(url: string): Promise<CheckResult> {
  // curl.exe is built into modern Windows. We probe just the port — even a
  // 401 response means the network path works (which is what matters for
  // OAuth callbacks).
  return new Promise<CheckResult>((resolve) => {
    const child = spawn(
      'cmd.exe',
      ['/c', `curl.exe -s -m 3 -o NUL -w %{http_code} ${url}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.on('error', (e) => resolve({ ok: false, detail: `cmd.exe error: ${e.message}` }));
    child.on('exit', () => {
      const trimmed = out.trim();
      if (!trimmed || trimmed === '000') {
        resolve({ ok: false, detail: `Windows curl could not connect (TCP failed)` });
      } else {
        resolve({ ok: true, detail: `HTTP ${trimmed} (Windows reaches WSL)` });
      }
    });
  });
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Diagnose WSL and network problems that prevent OAuth auto-callbacks from working.'
    )
    .action(async () => {
      const cfg = await loadCliConfig();
      const apiBase = normalizeApiBase(cfg.apiBase ?? getDefaultApiBase());
      const apiUrl = computeApiUrl(apiBase);
      const wsl = await isWsl();

      console.log(chalk.bold('\nEnvironment'));
      console.log(`  Config file:    ${CONFIG_PATH}`);
      console.log(`  API base:       ${apiBase}`);
      console.log(
        `  Mgmt key:       ${
          cfg.managementKey ? chalk.green('set') : chalk.yellow('unset (run `cpa connect`)')
        }`
      );
      console.log(`  Platform:       ${process.platform}${wsl ? ' (WSL)' : ''}`);

      const wslVersion = await readWslVersion();
      if (wslVersion) {
        const short = wslVersion.split(' ').slice(0, 3).join(' ');
        console.log(`  Kernel:         ${short}`);
      }

      if (wsl) {
        console.log(chalk.bold('\nWSL networking'));
        const wslconfig = await readWslConfig();
        if (wslconfig) {
          const mirrored = /networkingMode\s*=\s*mirrored/i.test(wslconfig);
          console.log(`  ~/.wslconfig:   ${chalk.green('found')}`);
          console.log(
            `  Mirrored mode:  ${
              mirrored
                ? chalk.green('on')
                : chalk.yellow('off (consider networkingMode=mirrored)')
            }`
          );
        } else {
          console.log(
            `  ~/.wslconfig:   ${chalk.dim(
              'not found or unreadable (default WSL2 NAT networking is in use)'
            )}`
          );
        }
      }

      console.log(chalk.bold('\nBackend reachability'));
      const fromWsl = await pingFromWsl(`${apiUrl}/latest-version`, cfg.managementKey ?? '');
      console.log(`  From WSL:       ${tag(fromWsl.ok)} ${fromWsl.detail}`);

      let fromWindowsOk = true;
      if (wsl) {
        const fromWindows = await pingFromWindows(`${apiUrl}/latest-version`);
        fromWindowsOk = fromWindows.ok;
        console.log(`  From Windows:   ${tag(fromWindows.ok)} ${fromWindows.detail}`);
      }

      if (!fromWsl.ok) {
        console.log(
          chalk.red(
            '\nBackend is not reachable from WSL itself. Check that CLIProxyAPI is running and the URL is correct.'
          )
        );
      } else if (wsl && !fromWindowsOk) {
        console.log(chalk.bold('\nWindows-side reach failed. To fix:'));
        console.log(
          '  1. Verify the backend listens on 0.0.0.0 (not 127.0.0.1). The Go server\n' +
            '     usually has a `host` config field — set it to 0.0.0.0.'
        );
        console.log(
          `  2. Enable mirrored networking. Edit ${chalk.cyan('%USERPROFILE%\\.wslconfig')}\n` +
            '     and add:'
        );
        console.log(chalk.dim('        [wsl2]'));
        console.log(chalk.dim('        networkingMode=mirrored'));
        console.log(
          `     then run ${chalk.cyan('wsl --shutdown')} from PowerShell and reopen WSL.`
        );
        console.log('  3. Check Windows Firewall for inbound TCP on the API port.');
        console.log(
          `  4. As a workaround, use ${chalk.cyan(
            '`cpa login <provider> --manual`'
          )} and paste the URL/code.`
        );
      } else {
        console.log(chalk.green('\nAll checks passed. OAuth auto-callback should work.'));
      }
    });
}
