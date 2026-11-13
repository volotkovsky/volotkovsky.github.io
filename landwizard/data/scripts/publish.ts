// npm run publish-data -- --region <name>
//
// Copies one region's output (data/out/<region>/, written by npm run tiles) and
// data/sources.json into app/static/data/, where the dev server and the static build serve
// them. app/static/data/ is git-ignored and holds one region at a time, so it is emptied
// first; nothing else under app/ is touched (setup.default.json lives in app/static/).

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, readArgs, required } from './args.ts';
import { DATA_DIR, REGION_RE } from './gis.ts';
import { REGION_FILES } from './release.ts';

const USAGE = 'npm run publish-data -- --region <name>';
const args = readArgs(USAGE, { region: { type: 'string' } });
const region = required(args.region, '--region', USAGE);
if (!REGION_RE.test(region)) fail('--region must be lowercase letters, digits and dashes, e.g. nc-halifax', USAGE);

const src = path.join(DATA_DIR, 'out', region);
const dest = path.resolve(DATA_DIR, '..', 'app', 'static', 'data');
const missing = REGION_FILES.required.filter((f) => !existsSync(path.join(src, f)));
if (missing.length) fail(`out/${region}/ lacks ${missing.join(', ')}; run npm run tiles -- --region ${region} first`);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
let bytes = 0;
let files = 0;
for (const f of [...REGION_FILES.required, ...REGION_FILES.optional]) {
  const from = path.join(src, f);
  if (!existsSync(from)) continue;
  await cp(from, path.join(dest, f), { recursive: true });
  for (const p of (await stat(from)).isDirectory() ? (await readdir(from)).map((x) => path.join(from, x)) : [from]) {
    bytes += (await stat(p)).size;
    files++;
  }
}
await cp(path.join(DATA_DIR, 'sources.json'), path.join(dest, 'sources.json'));
console.log(`published ${region}: ${files + 1} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(path.resolve(DATA_DIR, '..'), dest)}`);
