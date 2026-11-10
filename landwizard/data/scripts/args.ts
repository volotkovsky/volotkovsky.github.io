// Command-line options for the data scripts, read with node:util parseArgs.
// npm passes everything after `--` to the script: `npm run inspect -- --src raw/x.shp`.

import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

/** Print an error (and the usage line) and stop with exit code 1. */
export function fail(message: string, usage?: string): never {
  console.error(`error: ${message}`);
  if (usage) console.error(`usage: ${usage}`);
  process.exit(1);
}

/**
 * Parse process.argv against `options`. Unknown options and positionals are errors.
 * `-h` / `--help` prints the usage and exits.
 */
export function readArgs<const O extends ParseArgsOptionsConfig>(usage: string, options: O) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`usage: ${usage}`);
    process.exit(0);
  }
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    fail((err as Error).message, usage);
  }
}

/** Return a required string option, or fail with the usage line. */
export function required(value: string | undefined, flag: string, usage: string): string {
  if (value === undefined || value.trim() === '') fail(`${flag} is required`, usage);
  return value;
}

/** Split a comma list option (`--drop A,B`) into trimmed, non-empty items. */
export function list(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
