// npm run release -- --region <name> [--dry-run]
//
// Uploads one region's output to the GitHub Release `landwizard-data-<region>` of this
// repository with the GitHub CLI (`gh`, signed in with `gh auth login`), so CI can deploy
// the data without it ever entering git history (section 15.1, deploy workflow step 2).
//
// Release assets are flat files, so attrs/ goes up as one archive:
//   parcels.pmtiles, layers.pmtiles, parcels.fgb, substations.geojson, parcels.json,
//   sources.json, attrs.tar.gz (the attrs/ folder; unpack with `tar -xzf attrs.tar.gz`)
// The release is created when missing (marked not latest, so it never shows as the site
// repository's latest release), assets are replaced in place, and assets left over from an
// earlier upload that are no longer produced are deleted. --dry-run prints what it would
// upload and touches nothing.

import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, readArgs, required } from './args.ts';
import { DATA_DIR, REGION_RE, ensureGisUp, gis, run, toContainer } from './gis.ts';

/** What npm run tiles writes to out/<region>/ (shared with publish.ts). */
export const REGION_FILES = {
  required: ['parcels.pmtiles', 'layers.pmtiles', 'parcels.fgb', 'parcels.json', 'attrs'],
  optional: ['substations.geojson'],
};

export function releaseTag(region: string): string {
  return `landwizard-data-${region}`;
}

// Run only as a script (publish.ts imports REGION_FILES from here).
if (import.meta.main) await main();

async function main(): Promise<void> {
  const USAGE = 'npm run release -- --region <name> [--dry-run]';
  const args = readArgs(USAGE, { region: { type: 'string' }, 'dry-run': { type: 'boolean' } });
  const region = required(args.region, '--region', USAGE);
  if (!REGION_RE.test(region)) fail('--region must be lowercase letters, digits and dashes, e.g. nc-halifax', USAGE);
  const dry = args['dry-run'] === true;
  const tag = releaseTag(region);
  const out = path.join(DATA_DIR, 'out', region);
  const stage = `raw/${region}/derived/release`;

  const missing = REGION_FILES.required.filter((f) => !existsSync(path.join(out, f)));
  if (missing.length) fail(`out/${region}/ lacks ${missing.join(', ')}; run npm run tiles -- --region ${region} first`);

  const gh = (a: string[], capture = true) => run('gh', a, { capture });
  if (!dry) {
    try {
      await gh(['auth', 'status']);
    } catch (err) {
      const msg = (err as Error).message;
      fail(/ENOENT|not found/i.test(msg)
        ? 'the GitHub CLI (gh) is not installed: winget install --id GitHub.cli, then gh auth login'
        : `gh is not signed in: run gh auth login\n${msg}`);
    }
  }

  // attrs/ -> attrs.tar.gz (tar in the container, so it works the same on every host).
  try {
    await ensureGisUp();
  } catch (err) {
    fail((err as Error).message);
  }
  await rm(path.join(DATA_DIR, stage), { recursive: true, force: true });
  await mkdir(path.join(DATA_DIR, stage), { recursive: true });
  await gis('tar', ['-czf', toContainer(`${stage}/attrs.tar.gz`), '-C', toContainer(`out/${region}`), 'attrs']);

  const assets = [
    ...[...REGION_FILES.required, ...REGION_FILES.optional].filter((f) => f !== 'attrs' && existsSync(path.join(out, f))).map((f) => path.join(out, f)),
    path.join(DATA_DIR, 'sources.json'),
    path.join(DATA_DIR, stage, 'attrs.tar.gz'),
  ];
  console.log(`== release ${tag}${dry ? ' (dry run)' : ''}`);
  for (const a of assets) console.log(`  ${path.basename(a).padEnd(20)} ${((await stat(a)).size / 1024 / 1024).toFixed(2).padStart(7)} MB`);
  if (dry) return;

  let existing: string[] = [];
  try {
    existing = (JSON.parse(await gh(['release', 'view', tag, '--json', 'assets'])) as { assets: { name: string }[] }).assets.map((a) => a.name);
  } catch {
    console.log(`creating release ${tag}`);
    await gh(['release', 'create', tag, '--title', `LandWizard data: ${region}`, '--latest=false',
      '--notes', `Data files for the LandWizard map, region ${region}. Uploaded by npm run release; deployed by the Pages workflow.`]);
  }
  await gh(['release', 'upload', tag, ...assets, '--clobber'], false);
  const names = new Set(assets.map((a) => path.basename(a)));
  for (const old of existing.filter((n) => !names.has(n))) {
    console.log(`deleting stale asset ${old}`);
    await gh(['release', 'delete-asset', tag, old, '--yes']);
  }
  console.log(`uploaded ${assets.length} assets to ${tag}`);
}
