// Helpers for the `gis` container (docker/compose.yml): run GDAL, tippecanoe and
// pmtiles inside it, and talk to its PostGIS from the host.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/** landwizard/data on the host; mounted at /data in the container. */
export const DATA_DIR = path.resolve(import.meta.dirname, '..');
export const COMPOSE_FILE = path.resolve(DATA_DIR, '../docker/compose.yml');
export const CONTAINER_DATA = '/data';

/** Database settings, matching docker/compose.yml. PG* environment variables override them. */
export const DB = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? 'landwizard',
  password: process.env.PGPASSWORD ?? 'landwizard',
  database: process.env.PGDATABASE ?? 'landwizard',
};

/** GDAL connection string for ogr2ogr running inside the container (PostGIS is local there). */
export function ogrPg(schema?: string): string {
  const parts = [`dbname=${DB.database}`, `user=${DB.user}`, `password=${DB.password}`, 'host=localhost', 'port=5432'];
  if (schema) parts.push(`active_schema=${schema}`);
  return `PG:${parts.join(' ')}`;
}

/**
 * Map a host path (absolute, or relative to landwizard/data) to its path in the container.
 * Fails if the path is outside landwizard/data, since only that folder is mounted.
 */
export function toContainer(hostPath: string): string {
  const abs = path.resolve(DATA_DIR, hostPath);
  const rel = path.relative(DATA_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${hostPath} is outside ${DATA_DIR}; only that folder is mounted in the gis container`);
  }
  return path.posix.join(CONTAINER_DATA, ...rel.split(path.sep));
}

/** Resolve a host path relative to landwizard/data and check that it exists. */
export function dataPath(hostPath: string): string {
  const abs = path.resolve(DATA_DIR, hostPath);
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  return abs;
}

export interface RunOptions {
  /** Capture stdout and return it instead of streaming it to the terminal. */
  capture?: boolean;
  /** Echo the command before running it. */
  echo?: boolean;
  /** Collect stderr lines here instead of printing them (e.g. to summarize GDAL warnings). */
  stderrLines?: string[];
}

/** Run a command and resolve with its stdout (empty unless `capture`). Rejects on a non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  if (opts.echo) console.log(`$ ${[cmd, ...args].join(' ')}`);
  return new Promise((resolve, reject) => {
    const collect = opts.stderrLines;
    const child = spawn(cmd, args, { stdio: ['ignore', opts.capture ? 'pipe' : 'inherit', collect ? 'pipe' : 'inherit'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT' ? ' (is Docker Desktop installed and on PATH?)' : '';
      reject(new Error(`${cmd}: ${err.message}${hint}`));
    });
    child.on('close', (code) => {
      const errText = Buffer.concat(errChunks).toString('utf8');
      if (collect) collect.push(...errText.split(/\r?\n/).filter(Boolean));
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`${cmd} ${args[0] ?? ''} exited with code ${code}${errText ? `:\n${errText.slice(-2000)}` : ''}`));
    });
  });
}

/** Run a tool inside the gis container: `docker compose exec -T gis <tool> ...args`. Paths must be /data paths. */
export function gis(tool: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return run('docker', ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'gis', tool, ...args], opts);
}

/** Run a tool in the container and parse its stdout as JSON. */
export async function gisJson<T>(tool: string, args: string[], opts: Omit<RunOptions, 'capture'> = {}): Promise<T> {
  const out = await gis(tool, args, { ...opts, capture: true });
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`${tool} did not return JSON:\n${out.slice(0, 500)}`);
  }
}

/** Fail early with a clear message if the gis container is not running. */
export async function ensureGisUp(): Promise<void> {
  let out: string;
  try {
    out = await run('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '--status', 'running', '--services'], { capture: true });
  } catch (err) {
    throw new Error(`cannot reach Docker: ${(err as Error).message}`);
  }
  if (!out.split(/\r?\n/).includes('gis')) {
    throw new Error('the gis container is not running; start it with `npm run gis:up`');
  }
}

/** Open a PostGIS connection, run `fn`, and always close the connection. */
export async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client(DB);
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** Run one SQL statement and return its rows. */
export async function sql<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  return withDb(async (db) => (await db.query<R>(text, params)).rows);
}

/** Quote an SQL identifier (double quotes, doubled inside). */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
