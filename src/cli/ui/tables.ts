import Table from 'cli-table3';
import chalk from 'chalk';

const DEFAULT_TABLE_CHARS = {
  top: '─',
  'top-mid': '┬',
  'top-left': '┌',
  'top-right': '┐',
  bottom: '─',
  'bottom-mid': '┴',
  'bottom-left': '└',
  'bottom-right': '┘',
  left: '│',
  'left-mid': '├',
  mid: '─',
  'mid-mid': '┼',
  right: '│',
  'right-mid': '┤',
  middle: '│',
};

export function makeTable(head: string[]): Table.Table {
  return new Table({
    head: head.map((h) => chalk.bold(h)),
    chars: DEFAULT_TABLE_CHARS,
    style: { head: [], border: [] },
  });
}

export function statusBadge(disabled: boolean): string {
  return disabled ? chalk.red('disabled') : chalk.green('enabled');
}

export function maskedKeyTail(key: string, tail = 4): string {
  if (!key) return '';
  if (key.length <= tail) return key;
  return `${chalk.dim('…')}${key.slice(-tail)}`;
}
