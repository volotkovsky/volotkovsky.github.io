// npm run fetch -- --region <name> --src raw/<region>/<parcel file> [--layer <name>] [--force]
//
// Step 1 of the data build (section 7): downloads the national files once (TIGER counties,
// transmission lines, Cropland Data Layer), detects the county from the parcels, then
// downloads the overlays for it: OSM substations and, in one more Overpass query, OSM power
// lines, roads and waterways (by bbox); FEMA flood zones (by county FIPS); NWI wetlands (by
// state); 3DEP elevation tiles and the Cropland Data Layer clipped to the bbox. Vector layers
// are normalized to small GeoPackages (EPSG:4326, lowercase fields) that build.ts loads;
// rasters stay GeoTIFFs for the raster step. sources.json gets one entry per downloaded layer.
//
// Each layer has an ordered list of sources. The first is the one named in the spec; the
// others are official web services used when the first is blocked or offline. A file saved
// by hand at a source's drop-in path counts as downloaded, so any source can be fetched in a
// browser instead. Files already fetched are reused unless --force.
//
// Layout:
//   raw/_national/counties.gpkg       counties (geoid, statefp, countyfp, name)
//   raw/_national/lines.gpkg          lines (id, type, status, owner, voltage, volt_class, sub_1, sub_2)
//   raw/_national/2025_30m_cdls.zip   Cropland Data Layer as published (hand-saved copy used first)
//   raw/_national/2025_30m_cdls.tif   the same, extracted once: reading inside the zip takes minutes
//   raw/_national/3dep/USGS_1_<tile>.tif  optional hand-saved 3DEP tiles, used before the web copy
//   raw/_state/<ST>/                  NWI state GeoPackage, extracted
//   raw/_tmp/                         scratch space (on the data disk, never inside the Docker VM)
//   raw/<region>/fetched/region.json  detected county, CRS, bbox, layer availability
//   raw/<region>/fetched/substations.geojson, flood.gpkg, wetlands.gpkg
//   raw/<region>/fetched/osm.gpkg     layers osm_lines, roads, waterways (one Overpass query)
//   raw/<region>/fetched/dem.tif      3DEP 1 arc-second elevation, NAD83 degrees, bbox clip
//   raw/<region>/fetched/cdl.tif      Cropland Data Layer codes, EPSG:5070, bbox clip

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail, readArgs, required } from './args.ts';
import {
  type Bbox, type Detected, COUNTIES_FILE, detectFromTable, ensureCounties, printDetected, readRegion, writeRegion,
} from './detect.ts';
import {
  DATA_DIR, REGION_RE, dataPath, ensureGisUp, fmt, gis, gisExists, gisJson, ogrPg, toContainer, withDb,
} from './gis.ts';
import { type SourceEntry, today, upsertSources } from './sources.ts';
import { maxKv } from './voltage.ts';

const USAGE = 'npm run fetch -- --region <name> --src <parcel file under data/> [--layer <name>] [--force]';

/** Sent with every request. Generic on purpose: no personal or project contact details. */
const UA = 'landwizard-data-build/0.1 (GIS data pipeline; Node fetch)';

/** A download is restarted when no bytes arrive for this long. */
const STALL_MS = 60_000;

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OSM_KEYS = ['osm_lines', 'roads', 'waterways'] as const;
type OsmKey = (typeof OSM_KEYS)[number];

const DEM_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current';
const CDL_URL = 'https://www.nass.usda.gov/sites/default/files/Research_and_Science/Cropland/Release/datasets/2025_30m_cdls.zip';

/** GDAL options for /vsicurl/ reads: no directory listing of the bucket, retries, our user agent. */
const GDAL_HTTP = [
  '--config', 'GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR', '--config', 'GDAL_HTTP_MAX_RETRY', '5',
  '--config', 'GDAL_HTTP_RETRY_DELAY', '3', '--config', 'GDAL_HTTP_USERAGENT', UA, '--config', 'VSI_CACHE', 'TRUE',
];

const args = readArgs(USAGE, {
  region: { type: 'string' },
  src: { type: 'string' },
  layer: { type: 'string' },
  force: { type: 'boolean', default: false },
});

const region = required(args.region, '--region', USAGE);
if (!REGION_RE.test(region)) fail(`--region must be lowercase letters, digits and dashes, e.g. nc-halifax`, USAGE);
const src = required(args.src, '--src', USAGE);
const force = args.force ?? false;
let srcC: string;
try {
  dataPath(src);
  srcC = toContainer(src);
  await ensureGisUp();
} catch (err) {
  fail((err as Error).message);
}

const FETCHED = `raw/${region}/fetched`;
/** Container scratch folder. Under /data so large temporary files land on the data disk. */
const TMP = toContainer(`raw/_tmp/fetch-${process.pid}`);
const entries: SourceEntry[] = [];

await gis('mkdir', ['-p', TMP]);
try {
  // 1. National files, shared by all regions.
  console.log('== national files');
  const countiesFresh = await layerStep('counties', COUNTIES_FILE, fetchCounties, true);
  await layerStep('lines', 'raw/_national/lines.gpkg', fetchLines, true);

  // 2. County and projection.
  console.log('\n== detect county');
  const detected = await detect(countiesFresh);
  printDetected(detected);

  // 3. Overlays for this county. A failure marks the layer unavailable instead of stopping.
  console.log(`\n== overlays for ${detected.county}`);
  const previous = await readRegion(region);
  const layers = {
    substations: await layerStep('substations', `${FETCHED}/substations.geojson`, () => fetchSubstations(detected.bboxBuffered)),
    flood: await layerStep('flood', `${FETCHED}/flood.gpkg`, () => fetchFlood(detected)),
    wetlands: await layerStep('wetlands', `${FETCHED}/wetlands.gpkg`, () => fetchWetlands(detected)),
    osm: await layerStep('osm', `${FETCHED}/osm.gpkg`, (t) => fetchOsm(detected.bboxBuffered, t)),
    dem: await layerStep('elevation', `${FETCHED}/dem.tif`, (t) => fetchDem(detected.bboxBuffered, t)),
    cdl: await layerStep('landcover', `${FETCHED}/cdl.tif`, (t) => fetchCdl(detected, t)),
  };
  // A cached file from an earlier run counts as available; an OSM layer needs features.
  const osmCounts = layers.osm === false ? null : await osmLayerCounts(`${FETCHED}/osm.gpkg`);
  const available = {
    substations: layers.substations !== false,
    flood: layers.flood !== false,
    wetlands: layers.wetlands !== false,
    osm_lines: (osmCounts?.osm_lines ?? 0) > 0,
    roads: (osmCounts?.roads ?? 0) > 0,
    waterways: (osmCounts?.waterways ?? 0) > 0,
    dem: layers.dem !== false,
    cdl: layers.cdl !== false,
  };

  if (previous && previous.detected.fips !== detected.fips) {
    console.warn(`warning: ${FETCHED} was fetched for FIPS ${previous.detected.fips}; rerun with --force to refetch the overlays`);
  }
  await writeRegion({ v: 2, region, src, layer: args.layer ?? null, fetched: today(), detected, layers: available });
  if (entries.length) await upsertSources(entries);

  console.log('\n== summary');
  for (const [k, ok] of Object.entries(available)) console.log(`${k.padEnd(12)} ${ok ? 'ok' : 'UNAVAILABLE'}`);
  console.log(`wrote ${FETCHED}/region.json${entries.length ? `; sources.json updated for ${entries.map((e) => e.layer).join(', ')}` : ''}`);
} finally {
  await gis('rm', ['-rf', TMP]).catch(() => {});
}

// ---------------------------------------------------------------------------------------
// Layer steps

/**
 * Fetch one layer into `target` (host path relative to data/) unless it exists and !force.
 * Returns true when downloaded now, 'cached' when reused, false when every source failed.
 * With `fatal`, a failure stops the script (the national files are needed for detection).
 */
async function layerStep(
  name: string, target: string, fn: (target: string) => Promise<SourceEntry>, fatal = false,
): Promise<true | 'cached' | false> {
  if (!force && existsSync(path.join(DATA_DIR, target))) {
    console.log(`${name}: using ${target}`);
    return 'cached';
  }
  await mkdir(path.dirname(path.join(DATA_DIR, target)), { recursive: true });
  try {
    entries.push(await fn(target));
    console.log(`${name}: wrote ${target}`);
    return true;
  } catch (err) {
    const msg = `${name}: no source worked\n${(err as Error).message}`;
    if (fatal) fail(msg);
    console.warn(`warning: ${msg}\n${name} is marked unavailable for ${region}`);
    return false;
  }
}

interface Attempt<T> { label: string; run: () => Promise<T> }

/** Try sources in order; the error of each failed one is collected for the final message. */
async function firstWorking<T = SourceEntry>(name: string, attempts: Attempt<T>[]): Promise<T> {
  const errors: string[] = [];
  for (const a of attempts) {
    console.log(`${name}: trying ${a.label}`);
    try {
      return await a.run();
    } catch (err) {
      const text = (err as Error).message.split('\n').slice(0, 4).join('\n    ');
      console.warn(`${name}: ${a.label} failed: ${text}`);
      errors.push(`  - ${a.label}: ${text}`);
    }
  }
  throw new Error(errors.join('\n'));
}

async function fetchCounties(target: string): Promise<SourceEntry> {
  const zip = 'raw/_national/tl_2025_us_county.zip';
  const zipUrl = 'https://www2.census.gov/geo/tiger/TIGER2025/COUNTY/tl_2025_us_county.zip';
  const rest = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1';
  return firstWorking('counties', [
    {
      label: `TIGER/Line 2025 zip (drop-in: ${zip})`,
      run: async () => {
        await downloadOnce(zipUrl, zip);
        await normalize(`/vsizip/${toContainer(zip)}/tl_2025_us_county.shp`,
          'SELECT GEOID AS geoid, STATEFP AS statefp, COUNTYFP AS countyfp, NAMELSAD AS name FROM tl_2025_us_county',
          'counties', 'MULTIPOLYGON', target);
        return {
          layer: 'counties', name: 'US Census TIGER/Line 2025 counties', url: zipUrl, downloaded: today(),
          license: 'Public domain (US government work); used only to detect the county',
        };
      },
    },
    {
      label: 'Census TIGERweb counties service',
      run: async () => {
        // Generalized to ~50 m: enough for a majority vote of parcel centroids.
        const meta = await arcgisToGpkg(rest, {
          outFields: 'GEOID,STATE,COUNTY,NAME', maxAllowableOffset: '0.0005', geometryPrecision: '6',
        }, `${TMP}/counties-src.gpkg`, 500);
        await normalize(`${TMP}/counties-src.gpkg`,
          'SELECT GEOID AS geoid, STATE AS statefp, COUNTY AS countyfp, NAME AS name FROM src',
          'counties', 'MULTIPOLYGON', target);
        const vintage = /[A-Z][a-z]+ \d{1,2}, \d{4} vintage/.exec(meta.description)?.[0] ?? 'current vintage';
        return {
          layer: 'counties', name: `US Census TIGERweb counties (${vintage})`, url: rest,
          downloaded: today(), license: 'Public domain (US government work); used only to detect the county',
          note: 'Generalized to about 50 m; the TIGER/Line zip was not reachable',
        };
      },
    },
  ]);
}

async function fetchLines(target: string): Promise<SourceEntry> {
  const rest = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0';
  const select = (from: string) =>
    `SELECT ID AS id, TYPE AS type, STATUS AS status, OWNER AS owner, VOLTAGE AS voltage, VOLT_CLASS AS volt_class, SUB_1 AS sub_1, SUB_2 AS sub_2 FROM "${from}"`;
  const license = 'US government works (data.gov record); the HIFLD Open archive states no license';
  const manual = ['raw/_national/transmission_lines.geojson', 'raw/_national/transmission_lines.zip'];
  return firstWorking('lines', [
    {
      label: `HIFLD archive file from DataLumos (drop-in: ${manual.join(' or ')})`,
      run: async () => {
        const file = manual.find((f) => existsSync(path.join(DATA_DIR, f)));
        if (!file) throw new Error('not present (DataLumos needs a sign-in, so this file is only used when saved by hand)');
        const c = file.endsWith('.zip') ? `/vsizip/${toContainer(file)}` : toContainer(file);
        await normalize(c, select(await firstLayer(c)), 'lines', 'MULTILINESTRING', target);
        return {
          layer: 'lines', name: 'HIFLD Open Electric Power Transmission Lines (DataLumos archive)',
          url: 'https://www.datalumos.org/datalumos/project/240591/version/V1/view', downloaded: today(), license,
        };
      },
    },
    {
      label: 'HIFLD transmission lines feature service',
      run: async () => {
        const meta = await arcgisToGpkg(rest, {
          outFields: 'ID,TYPE,STATUS,OWNER,VOLTAGE,VOLT_CLASS,SUB_1,SUB_2',
        }, `${TMP}/lines-src.gpkg`, 2000);
        await normalize(`${TMP}/lines-src.gpkg`, select('src'), 'lines', 'MULTILINESTRING', target);
        return {
          layer: 'lines', name: 'HIFLD Electric Power Transmission Lines (feature service)', url: rest,
          downloaded: today(), license, ...(meta.updated ? { updated: meta.updated } : {}),
          note: 'HIFLD Open was retired on 26 Aug 2025; the data is frozen at its last update',
        };
      },
    },
  ]);
}

async function fetchSubstations(bbox: Bbox): Promise<SourceEntry> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:180];nwr["power"="substation"](${s},${w},${n},${e});out tags center;`;
  return firstWorking('substations', OVERPASS.map((url) => ({
    label: `Overpass ${new URL(url).host}`,
    run: async () => {
      const res = await request(url, {
        method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(240_000),
      });
      const data = (await res.json()) as OverpassResult;
      if (data.remark && /error|timed out/i.test(data.remark)) throw new Error(`Overpass: ${data.remark}`);
      const features = data.elements.flatMap((el) => {
        const lon = el.lon ?? el.center?.lon;
        const lat = el.lat ?? el.center?.lat;
        if (lon === undefined || lat === undefined) return [];
        const t = el.tags ?? {};
        return [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            osm_id: `${el.type}/${el.id}`, name: t.name ?? null, operator: t.operator ?? null,
            substation: t.substation ?? null, voltage: t.voltage ?? null, max_kv: maxKv(t.voltage),
          },
        }];
      });
      const out = path.join(DATA_DIR, FETCHED, 'substations.geojson');
      await writeFile(`${out}.part`, JSON.stringify({ type: 'FeatureCollection', features }));
      await rename(`${out}.part`, out);
      console.log(`substations: ${fmt(features.length)} from OpenStreetMap`);
      return {
        layer: 'substations', name: 'OpenStreetMap power=substation (Overpass API)',
        url: 'https://wiki.openstreetmap.org/wiki/Tag:power=substation', downloaded: today(),
        license: '© OpenStreetMap contributors, ODbL 1.0',
        ...(data.osm3s?.timestamp_osm_base ? { updated: data.osm3s.timestamp_osm_base.slice(0, 10) } : {}),
      };
    },
  })));
}

async function fetchFlood(d: Detected): Promise<SourceEntry> {
  const product = `NFHL_${d.fips}C`;
  const zip = `${FETCHED}/${product}.zip`;
  const mscUrl = `https://msc.fema.gov/portal/downloadProduct?productID=${product}`;
  const esri = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0';
  const select = (from: string) => `SELECT FLD_ZONE AS fld_zone, ZONE_SUBTY AS zone_subty, SFHA_TF AS sfha_tf FROM "${from}"`;
  return firstWorking('flood', [
    {
      label: `FEMA Map Service Center ${product} (drop-in: ${zip})`,
      run: async () => {
        await downloadOnce(mscUrl, zip);
        const dir = `${TMP}/nfhl`;
        await gis('unzip', ['-o', '-q', toContainer(zip), '-d', dir]);
        // County NFHL zips hold either shapefiles or a file geodatabase.
        const found = (await gis('find', [dir, '(', '-iname', 'S_FLD_HAZ_AR.shp', '-o', '-iname', '*.gdb', ')'], { capture: true }))
          .split('\n').map((s) => s.trim()).filter(Boolean);
        const source = found.find((f) => /\.shp$/i.test(f)) ?? found.find((f) => /\.gdb$/i.test(f));
        if (!source) throw new Error(`${zip} has no S_FLD_HAZ_AR layer`);
        await normalize(source, select('S_FLD_HAZ_AR'), 'flood', 'MULTIPOLYGON', `${FETCHED}/flood.gpkg`);
        return {
          layer: 'flood', name: `FEMA National Flood Hazard Layer, ${d.county} (${product})`, url: mscUrl,
          downloaded: today(), license: 'Public domain (FEMA); flood hazard area polygons',
        };
      },
    },
    {
      label: 'Esri Living Atlas USA Flood Hazard Areas (NFHL copy) by bbox',
      run: async () => {
        const meta = await arcgisToGpkg(esri, { outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF', ...bboxParams(d.bboxBuffered) },
          `${TMP}/flood-src.gpkg`, 750);
        if (meta.count === 0) throw new Error('no flood hazard polygons in the region (no effective NFHL?)');
        await normalize(`${TMP}/flood-src.gpkg`, select('src'), 'flood', 'MULTIPOLYGON', `${FETCHED}/flood.gpkg`);
        return {
          layer: 'flood', name: 'FEMA National Flood Hazard Layer via Esri Living Atlas (USA Flood Hazard Areas)',
          url: esri, downloaded: today(), license: 'FEMA NFHL is public domain; this copy is served under the Esri terms of use',
          ...(meta.updated ? { updated: meta.updated } : {}),
          note: 'The FEMA Map Service Center download was not reachable; same zones, copied by Esri',
        };
      },
    },
  ]);
}

async function fetchWetlands(d: Detected): Promise<SourceEntry> {
  const stateDir = `raw/_state/${d.state}`;
  const zipName = `${d.state}_geopackage_wetlands.zip`;
  const zipUrl = `https://documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/${zipName}`;
  const rest = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0';
  const select = (from: string) => `SELECT ATTRIBUTE AS attribute, WETLAND_TYPE AS wetland_type FROM "${from}"`;
  const target = `${FETCHED}/wetlands.gpkg`;
  const license = 'Public domain (USFWS); not a jurisdictional wetland delineation';
  return firstWorking('wetlands', [
    {
      label: `NWI ${d.state} state GeoPackage (drop-in: ${stateDir}/${zipName})`,
      run: async () => {
        let gpkg = await findStateGpkg(stateDir);
        if (!gpkg) {
          await downloadOnce(zipUrl, `${stateDir}/${zipName}`);
          console.log(`wetlands: extracting ${zipName}`);
          await gis('unzip', ['-o', '-q', toContainer(`${stateDir}/${zipName}`), '-d', toContainer(stateDir)]);
          gpkg = await findStateGpkg(stateDir);
          if (!gpkg) throw new Error(`${zipName} has no .gpkg`);
          await rm(path.join(DATA_DIR, stateDir, zipName)); // the extracted GeoPackage is the cache
        }
        // ogr2ogr can't combine -spat_srs with -sql, so cut the region out first, then rename.
        const layer = await wetlandsLayer(gpkg);
        const cut = `${TMP}/wetlands-src.gpkg`;
        await gis('rm', ['-f', cut]);
        await gis('ogr2ogr', [
          '-f', 'GPKG', cut, gpkg, layer, '-nln', 'src', '-lco', 'GEOMETRY_NAME=geom', '-select', 'ATTRIBUTE,WETLAND_TYPE',
          '-spat', ...d.bboxBuffered.map(String), '-spat_srs', 'EPSG:4326', '-nlt', 'PROMOTE_TO_MULTI',
        ], { stderrLines: [] });
        await normalize(cut, select('src'), 'wetlands', 'MULTIPOLYGON', target);
        return {
          layer: 'wetlands', name: `USFWS National Wetlands Inventory, ${d.state} state download`, url: zipUrl,
          downloaded: today(), license,
        };
      },
    },
    {
      label: 'NWI wetlands map service by bbox',
      run: async () => {
        const meta = await arcgisToGpkg(rest, { outFields: 'ATTRIBUTE,WETLAND_TYPE', ...bboxParams(d.bboxBuffered) },
          `${TMP}/wetlands-src.gpkg`, 500);
        await normalize(`${TMP}/wetlands-src.gpkg`, select('src'), 'wetlands', 'MULTIPOLYGON', target);
        return {
          layer: 'wetlands', name: 'USFWS National Wetlands Inventory (map service)', url: rest, downloaded: today(), license,
          ...(meta.updated ? { updated: meta.updated } : {}), note: 'The state download failed; same inventory from the map service',
        };
      },
    },
  ]);
}

/**
 * One Overpass query for the three OSM line layers (section 15.3): power lines with voltage
 * (fills the gap below HIFLD's 100 kV floor), roads for road access (F-33) and waterways for
 * the water buffer. Written as one GeoPackage with layers osm_lines, roads and waterways.
 * Returns the osm_lines entry; the roads and waterways entries are added to `entries` here.
 */
async function fetchOsm(bbox: Bbox, target: string): Promise<SourceEntry> {
  const [w, s, e, n] = bbox;
  const b = `(${s},${w},${n},${e})`;
  const query = `[out:json][timeout:600][maxsize:1073741824];(`
    + `way["power"~"^(line|minor_line)$"]${b};way["highway"]${b};way["waterway"~"^(river|stream|canal)$"]${b};`
    + ');out tags geom;';
  const data = await firstWorking('osm', OVERPASS.map((url) => ({
    label: `Overpass ${new URL(url).host}`,
    run: async () => {
      const res = await request(url, {
        method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(900_000),
      });
      const body = (await res.json()) as OverpassResult;
      if (body.remark && /error|timed out|out of memory/i.test(body.remark)) throw new Error(`Overpass: ${body.remark}`);
      return body;
    },
  })));

  // A way can belong to more than one layer (rare: a power line tagged on a canal bank).
  const features: Record<OsmKey, string[]> = { osm_lines: [], roads: [], waterways: [] };
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const t = el.tags ?? {};
    const coordinates = el.geometry.map((p) => [p.lon, p.lat]);
    const add = (k: OsmKey, props: Record<string, string | number | null>) => features[k].push(JSON.stringify({
      type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { osm_id: `way/${el.id}`, ...props },
    }));
    const tag = (k: string) => t[k] ?? null;
    if (t.power === 'line' || t.power === 'minor_line') {
      add('osm_lines', {
        power: t.power, voltage: tag('voltage'), max_kv: maxKv(t.voltage), operator: tag('operator'),
        name: tag('name'), location: tag('location'),
      });
    }
    if (t.highway) {
      add('roads', {
        highway: t.highway, access: tag('access'), motor_vehicle: tag('motor_vehicle'), service: tag('service'),
        name: tag('name'), ref: tag('ref'), surface: tag('surface'), tiger_reviewed: tag('tiger:reviewed'),
      });
    }
    if (t.waterway && /^(river|stream|canal)$/.test(t.waterway)) {
      add('waterways', {
        waterway: t.waterway, name: tag('name'), intermittent: tag('intermittent'), tunnel: tag('tunnel'),
      });
    }
  }

  const out = `${TMP}/osm.gpkg`;
  await gis('rm', ['-f', out]);
  const tmpDir = path.join(DATA_DIR, 'raw', '_tmp');
  await mkdir(tmpDir, { recursive: true });
  for (const [i, k] of OSM_KEYS.entries()) {
    const file = path.join(tmpDir, `osm-${process.pid}-${k}.geojson`);
    await writeFile(file, `{"type":"FeatureCollection","features":[${features[k].join(',')}]}`);
    try {
      await gis('ogr2ogr', [
        '-f', 'GPKG', ...(i > 0 ? ['-update'] : []), out, toContainer(file),
        '-nln', k, '-nlt', 'LINESTRING', '-t_srs', 'EPSG:4326', '-lco', 'GEOMETRY_NAME=geom',
      ], { stderrLines: [] });
    } finally {
      await rm(file, { force: true });
    }
    console.log(`osm: ${fmt(features[k].length)} ${k}`);
  }
  const dest = toContainer(target);
  await gis('cp', [out, `${dest}.part`]);
  await gis('mv', ['-f', `${dest}.part`, dest]);

  const common = {
    downloaded: today(), license: '© OpenStreetMap contributors, ODbL 1.0',
    ...(data.osm3s?.timestamp_osm_base ? { updated: data.osm3s.timestamp_osm_base.slice(0, 10) } : {}),
  };
  entries.push(
    {
      layer: 'roads', name: 'OpenStreetMap highway=* (Overpass API)', url: 'https://wiki.openstreetmap.org/wiki/Key:highway',
      ...common, note: 'Many rural US roads come from the 2007 TIGER import and are unreviewed (tiger:reviewed=no)',
    },
    {
      layer: 'waterways', name: 'OpenStreetMap waterway=river, stream, canal (Overpass API)',
      url: 'https://wiki.openstreetmap.org/wiki/Key:waterway', ...common,
    },
  );
  return {
    layer: 'osm_lines', name: 'OpenStreetMap power=line and minor_line (Overpass API)',
    url: 'https://wiki.openstreetmap.org/wiki/Tag:power=line', ...common,
    note: 'Adds lines under 100 kV, which the HIFLD file leaves out; rural US coverage is uneven',
  };
}

/** Feature count per layer of fetched/osm.gpkg (a layer missing from the file counts 0). */
async function osmLayerCounts(target: string): Promise<Record<OsmKey, number>> {
  const info = await gisJson<{ layers: { name: string; featureCount?: number }[] }>(
    'ogrinfo', ['-json', '-so', '-ro', toContainer(target)]);
  const counts = { osm_lines: 0, roads: 0, waterways: 0 };
  for (const l of info.layers) if (l.name in counts) counts[l.name as OsmKey] = l.featureCount ?? 0;
  return counts;
}

/**
 * 3DEP 1 arc-second tiles covering the bbox, read with /vsicurl/ (no full download), mosaicked
 * in a VRT and cut to the bbox without resampling. A tile saved by hand under
 * raw/_national/3dep/ is used instead of the web copy; a tile the bucket lacks (open sea) is skipped.
 */
async function fetchDem(bbox: Bbox, target: string): Promise<SourceEntry> {
  const [w, s, e, n] = bbox;
  const tiles: string[] = [];
  // A tile is named by its north-west corner: n37w078 covers 36-37°N, 77-78°W.
  for (let lat = Math.ceil(n); lat >= Math.floor(s) + 1; lat--) {
    for (let lon = Math.floor(w); lon <= Math.ceil(e) - 1; lon++) tiles.push(demTileName(lat, lon));
  }
  const sources: string[] = [];
  const missing: string[] = [];
  let local = 0;
  for (const t of tiles) {
    const saved = `raw/_national/3dep/USGS_1_${t}.tif`;
    if (existsSync(path.join(DATA_DIR, saved))) {
      sources.push(toContainer(saved));
      local++;
      continue;
    }
    const url = `${DEM_BASE}/${t}/USGS_1_${t}.tif`;
    try {
      await request(url, { method: 'HEAD' });
      sources.push(`/vsicurl/${url}`);
    } catch (err) {
      if (!/HTTP (403|404)/.test((err as Error).message)) throw err;
      missing.push(t);
    }
  }
  if (!sources.length) throw new Error(`no 3DEP tile found for ${tiles.join(', ')}`);
  console.log(`elevation: ${tiles.length} tiles (${tiles.join(', ')})${local ? `, ${local} saved by hand` : ''}`
    + `${missing.length ? `; not published: ${missing.join(', ')}` : ''}`);

  const vrt = `${TMP}/dem.vrt`;
  const tif = `${TMP}/dem.tif`;
  await gis('gdalbuildvrt', [...GDAL_HTTP, '-q', '-overwrite', vrt, ...sources]);
  // The tiles are NAD83 degrees; the WGS84 bbox is used as is (the datums differ by about 1 m).
  await gis('gdal_translate', [
    ...GDAL_HTTP, '-q', '-projwin', String(w), String(n), String(e), String(s),
    '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=3', '-co', 'TILED=YES', vrt, tif,
  ]);
  const st = await rasterStats(tif);
  console.log(`elevation: ${st.width} x ${st.height} px, ${st.min.toFixed(0)}-${st.max.toFixed(0)} m, ${st.validPct.toFixed(1)}% with data`);
  if (st.validPct === 0) throw new Error('the clipped DEM holds no data');
  await gis('cp', [tif, `${toContainer(target)}.part`]);
  await gis('mv', ['-f', `${toContainer(target)}.part`, toContainer(target)]);
  return {
    layer: 'elevation', name: 'USGS 3D Elevation Program, 1 arc-second DEM', url: 'https://www.usgs.gov/3d-elevation-program',
    downloaded: today(), license: 'Public domain (USGS)', note: `Tiles ${tiles.filter((t) => !missing.includes(t)).join(', ')}`,
  };
}

/**
 * Cropland Data Layer clipped to the bbox, kept in its own grid (EPSG:5070, 30 m, class codes).
 * The national zip (a hand-saved raw/_national copy first) is extracted once next to itself,
 * since reading the GeoTIFF inside the zip takes minutes per clip.
 */
async function fetchCdl(d: Detected, target: string): Promise<SourceEntry> {
  if (d.crs !== 5070) throw new Error('the Cropland Data Layer covers the conterminous US only');
  const national = 'raw/_national';
  const tifName = '2025_30m_cdls.tif';
  const zip = `${national}/2025_30m_cdls.zip`;
  const src = `${national}/${tifName}`;
  if (!existsSync(path.join(DATA_DIR, src))) {
    await downloadOnce(CDL_URL, zip);
    console.log(`landcover: extracting ${tifName} from ${path.posix.basename(zip)} (about 2 GB, once)`);
    const dir = `${TMP}/cdl`;
    await gis('unzip', ['-o', '-q', '-j', toContainer(zip), '2025_30m_cdls.*', '-d', dir]);
    // Sidecars (class names, colors) first; the GeoTIFF last, so its presence means "complete".
    const dest = toContainer(national);
    await gis('sh', ['-c', `cd ${dir} && for f in *; do [ "$f" = ${tifName} ] || mv -f "$f" ${dest}/; done && mv -f ${tifName} ${dest}/`]);
  }

  // The bbox edges are curves in Albers, so the window comes from the densified outline,
  // snapped outward to the CDL pixel grid so no pixel is resampled.
  const srcC = toContainer(src);
  const gt = (await gisJson<{ geoTransform: number[] }>('gdalinfo', ['-json', srcC])).geoTransform;
  const [ox, px, , oy, , py] = gt as [number, number, number, number, number, number];
  const win = await withDb(async (db) => (await db.query<{ x0: number; y0: number; x1: number; y1: number }>(`
    WITH g AS (SELECT ST_Transform(ST_Segmentize(ST_MakeEnvelope($1, $2, $3, $4, 4326), 0.01), 5070) AS g)
    SELECT ST_XMin(g) AS x0, ST_YMin(g) AS y0, ST_XMax(g) AS x1, ST_YMax(g) AS y1 FROM g`, d.bboxBuffered)).rows[0]!);
  const ys = -py;
  const x0 = ox + Math.floor((win.x0 - ox) / px) * px;
  const x1 = ox + Math.ceil((win.x1 - ox) / px) * px;
  const y1 = oy - Math.floor((oy - win.y1) / ys) * ys;
  const y0 = oy - Math.ceil((oy - win.y0) / ys) * ys;

  const tif = `${TMP}/cdl.tif`;
  await gis('gdal_translate', [
    '-q', '-projwin', String(x0), String(y1), String(x1), String(y0),
    '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', srcC, tif,
  ]);
  const st = await rasterStats(tif);
  console.log(`landcover: ${st.width} x ${st.height} px, ${st.validPct.toFixed(1)}% classified`);
  if (st.validPct === 0) throw new Error('the region lies outside the Cropland Data Layer');
  await gis('cp', [tif, `${toContainer(target)}.part`]);
  await gis('mv', ['-f', `${toContainer(target)}.part`, toContainer(target)]);
  return {
    layer: 'landcover', name: 'USDA NASS Cropland Data Layer 2025, 30 m',
    url: 'https://www.nass.usda.gov/Research_and_Science/Cropland/Release/', downloaded: today(),
    license: 'Public domain (USDA NASS), free to redistribute',
  };
}

// ---------------------------------------------------------------------------------------
// Detection: load parcel geometries only into a temporary table, vote, drop it.

async function detect(countiesFresh: true | 'cached' | false): Promise<Detected> {
  const table = `detect_${process.pid}`;
  return withDb(async (db) => {
    await ensureCounties(db, countiesFresh === true);
    await gis('ogr2ogr', [
      '-f', 'PostgreSQL', ogrPg(), srcC, ...(args.layer ? [args.layer] : []),
      '-nln', table, '-lco', 'SCHEMA=ref', '-lco', 'GEOMETRY_NAME=geom', '-lco', 'SPATIAL_INDEX=NONE',
      '-select', '', '-nlt', 'PROMOTE_TO_MULTI', '-t_srs', 'EPSG:4326', '-overwrite',
    ], { stderrLines: [] });
    try {
      return await detectFromTable(db, 'ref', table);
    } finally {
      await db.query(`DROP TABLE IF EXISTS ref.${table}`);
    }
  });
}

// ---------------------------------------------------------------------------------------
// Helpers

/**
 * ogr2ogr a source into a one-layer GeoPackage (EPSG:4326), written to a temp file and moved
 * in place. `sqlText` is a plain `SELECT a AS x, … FROM "layer"` without the geometry column.
 */
async function normalize(source: string, sqlText: string, layer: string, nlt: string, target: string, extra: string[] = []): Promise<void> {
  // A GeoPackage runs -sql in SQLite itself, which keeps only the columns named, so the
  // geometry column (always `geom` in the GeoPackages written here) must be selected.
  // Shapefile and geodatabase sources use OGR SQL, which adds the geometry by itself.
  if (/\.gpkg$/i.test(source)) sqlText = sqlText.replace(/^SELECT /i, 'SELECT geom, ');
  const tmp = `${TMP}/${layer}-out.gpkg`;
  await gis('rm', ['-f', tmp]);
  await gis('ogr2ogr', [
    '-f', 'GPKG', tmp, source, '-sql', sqlText, '-nln', layer, '-nlt', nlt, '-t_srs', 'EPSG:4326', ...extra,
  ], { stderrLines: [] });
  const check = await gisJson<{ features: { properties: { n: number; g: number } }[] }>('ogr2ogr', [
    '-f', 'GeoJSON', '/vsistdout/', tmp, '-dialect', 'SQLite',
    '-sql', `SELECT COUNT(*) AS n, COUNT(geom) AS g FROM "${layer}"`,
  ]);
  const { n, g } = check.features[0]?.properties ?? { n: 0, g: 0 };
  if (n > 0 && g < n) throw new Error(`${layer}: ${fmt(n - g)} of ${fmt(n)} features lost their geometry`);
  const dest = toContainer(target);
  await gis('cp', [tmp, `${dest}.part`]);
  await gis('mv', ['-f', `${dest}.part`, dest]);
}

interface ArcgisMeta { count: number; updated?: string; description: string }

/**
 * Download an ArcGIS feature/map service layer query into a GeoPackage layer `src`.
 *
 * Paging happens here rather than in GDAL's ESRIJSON driver: ArcGIS services sometimes answer
 * a valid page with HTTP 200 and an `{"error": …}` body (seen on the HIFLD service), which
 * GDAL can't retry. Each page is retried on its own and streamed into one ESRIJSON file under
 * raw/_tmp/, which ogr2ogr then reads. The expected count is checked.
 */
async function arcgisToGpkg(layerUrl: string, params: Record<string, string>, out: string, page: number): Promise<ArcgisMeta> {
  const info = (await (await request(`${layerUrl}?f=json`)).json()) as ArcgisLayerInfo;
  if (info.error) throw new Error(`${layerUrl}: ${info.error.message}`);
  const oid = info.objectIdField ?? info.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
  const base = { where: '1=1', outSR: '4326', f: 'json', ...params };

  const countRes = (await (await request(`${layerUrl}/query?${new URLSearchParams({ ...base, returnCountOnly: 'true' })}`)).json()) as { count?: number; error?: { message: string } };
  if (countRes.error || countRes.count === undefined) throw new Error(`count query failed: ${countRes.error?.message ?? 'no count'}`);
  const count = countRes.count;
  const size = Math.min(page, info.maxRecordCount ?? page);
  console.log(`  ${fmt(count)} features, ${Math.ceil(count / size)} pages of ${size}`);

  await gis('rm', ['-f', out]);
  if (count > 0) {
    const tmpDir = path.join(DATA_DIR, 'raw', '_tmp');
    await mkdir(tmpDir, { recursive: true });
    const jsonFile = path.join(tmpDir, `${path.posix.basename(out, '.gpkg')}-${process.pid}.json`);
    const stream = createWriteStream(jsonFile);
    const write = (s: string) => new Promise<void>((res, rej) => stream.write(s, (e) => (e ? rej(e) : res())));
    try {
      let written = 0;
      for (let offset = 0; offset < count; offset += size) {
        const q = new URLSearchParams({
          ...base, outFields: params.outFields ?? '*', orderByFields: oid,
          resultOffset: String(offset), resultRecordCount: String(size),
        });
        const pageNo = offset / size + 1;
        const { features, ...header } = await retry(`page ${pageNo}`, async () => {
          const body = (await (await request(`${layerUrl}/query?${q}`)).json()) as EsriPage;
          if (body.error || !Array.isArray(body.features)) throw new Error(body.error?.message ?? 'no features in the response');
          return body as EsriPage & { features: unknown[] };
        }, 6);
        if (offset === 0) await write(`${JSON.stringify(header).slice(0, -1)},"features":[`);
        for (const f of features) await write(`${written++ ? ',' : ''}${JSON.stringify(f)}`);
        process.stdout.write(`  page ${pageNo} of ${Math.ceil(count / size)}\r`);
        if (features.length === 0) break;
      }
      await write(']}');
      await new Promise<void>((res, rej) => stream.end((e?: Error | null) => (e ? rej(e) : res())));
      process.stdout.write('\n');
      await gis('ogr2ogr', ['-f', 'GPKG', out, `ESRIJSON:${toContainer(jsonFile)}`, '-nln', 'src', '-nlt', 'PROMOTE_TO_MULTI'],
        { stderrLines: [] });
    } finally {
      stream.destroy();
      await rm(jsonFile, { force: true });
    }
    const got = (await gisJson<{ layers: { featureCount?: number }[] }>('ogrinfo', ['-json', '-so', out, 'src'])).layers[0]?.featureCount ?? 0;
    if (got !== count) throw new Error(`expected ${fmt(count)} features, got ${fmt(got)} (paging stopped early?)`);
  }
  const edited = info.editingInfo?.dataLastEditDate;
  return {
    count,
    description: info.description?.replace(/<[^>]*>/g, '').trim() ?? '',
    ...(edited ? { updated: new Date(edited).toISOString().slice(0, 10) } : {}),
  };
}

function bboxParams(b: Bbox): Record<string, string> {
  return {
    geometry: b.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
  };
}

/** Download `url` to `target` (relative to data/) unless the file is already there (a hand-saved copy counts). */
async function downloadOnce(url: string, target: string): Promise<void> {
  const file = path.join(DATA_DIR, target);
  if (existsSync(file)) {
    console.log(`  using ${target}`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  // A connection dropped mid-file restarts the download.
  await retry(`download ${path.basename(target)}`, async () => {
    // Abort when no bytes arrive for STALL_MS: a stalled connection otherwise hangs forever.
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(new Error(`no data for ${STALL_MS / 1000} s`)), STALL_MS);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error(`no data for ${STALL_MS / 1000} s`)), STALL_MS);
    };
    try {
      await downloadAttempt(stall.signal, kick);
    } finally {
      clearTimeout(timer);
    }
  }, 4);
  await rename(`${file}.part`, file);

  async function downloadAttempt(signal: AbortSignal, kick: () => void): Promise<void> {
    const res = await request(url, { signal }, 1);
    kick();
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) throw new Error(`${url} returned a web page, not a file`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let done = 0;
    let shown = -1;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        kick();
        done += chunk.length;
        const step = total ? Math.floor((done / total) * 10) : Math.floor(done / 50e6);
        if (step !== shown) {
          shown = step;
          process.stdout.write(`  ${(done / 1e6).toFixed(0)} MB${total ? ` of ${(total / 1e6).toFixed(0)} MB` : ''}\r`);
        }
        cb(null, chunk);
      },
    });
    if (!res.body) throw new Error(`${url}: empty response`);
    await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(`${file}.part`));
    process.stdout.write('\n');
    if (total && done !== total) throw new Error(`got ${fmt(done)} of ${fmt(total)} bytes`);
  }
}


/**
 * fetch() with the project user agent; non-2xx and network errors become readable errors.
 * Connection resets, timeouts, 429 and 5xx are retried (government servers drop connections
 * now and then); other HTTP errors such as 403 or 404 fail at once.
 */
async function request(url: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    let error: Error;
    try {
      const res = await fetch(url, {
        ...init, headers: { 'User-Agent': UA, ...init.headers }, redirect: 'follow',
        signal: init.signal ?? AbortSignal.timeout(120_000),
      });
      if (res.ok) return res;
      const blocked = res.status === 403 && /cloudflare/i.test(res.headers.get('server') ?? '') ? ' (blocked by Cloudflare)' : '';
      error = new Error(`${host}: HTTP ${res.status} ${res.statusText}${blocked}`);
      if (res.status !== 429 && res.status < 500) throw error;
    } catch (err) {
      if (err === error!) throw err;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      error = new Error(`${host}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
    }
    if (attempt >= tries) throw error;
    console.warn(`  ${error.message}; retry ${attempt} of ${tries - 1}`);
    await sleep(2000 * attempt);
  }
}

/** Run `fn` up to `tries` times, for steps whose failure is usually a dropped connection. */
async function retry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw err;
      console.warn(`  ${label} failed (${(err as Error).message.split('\n').find((l) => l.trim()) ?? 'error'}); retry ${attempt} of ${tries - 1}`);
      await sleep(3000 * attempt);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function firstLayer(containerPath: string): Promise<string> {
  const info = await gisJson<{ layers: { name: string }[] }>('ogrinfo', ['-json', '-so', '-ro', containerPath]);
  const name = info.layers[0]?.name;
  if (!name) throw new Error(`${containerPath} has no layers`);
  return name;
}

/** The extracted NWI GeoPackage in raw/_state/<ST>/ (any depth), as a container path. */
async function findStateGpkg(stateDir: string): Promise<string | null> {
  const dir = toContainer(stateDir);
  if (!(await gisExists(dir))) return null;
  const out = await gis('find', [dir, '-iname', '*.gpkg'], { capture: true });
  return out.split('\n').map((s) => s.trim()).find(Boolean) ?? null;
}

/** NWI state GeoPackages hold e.g. NC_Wetlands plus project-metadata and riparian layers. */
async function wetlandsLayer(gpkg: string): Promise<string> {
  const names = (await gisJson<{ layers: { name: string }[] }>('ogrinfo', ['-json', '-so', '-ro', gpkg])).layers.map((l) => l.name);
  const name = names.find((n) => /^[A-Z]{2}_Wetlands$/i.test(n)) ?? names.find((n) => /wetlands$/i.test(n));
  if (!name) throw new Error(`no wetlands layer in ${gpkg}; layers: ${names.join(', ')}`);
  return name;
}

interface OverpassResult {
  remark?: string;
  osm3s?: { timestamp_osm_base?: string };
  elements: {
    type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number };
    geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>;
  }[];
}

/** 3DEP tile name from its north-west corner, e.g. (37, -78) -> n37w078. */
function demTileName(lat: number, lonWest: number): string {
  const ns = `${lat >= 0 ? 'n' : 's'}${String(Math.abs(lat)).padStart(2, '0')}`;
  const ew = `${lonWest < 0 ? 'w' : 'e'}${String(Math.abs(lonWest)).padStart(3, '0')}`;
  return ns + ew;
}

interface RasterStats { width: number; height: number; min: number; max: number; validPct: number }

/** Size and band 1 statistics of a raster in the container (nodata pixels excluded). */
async function rasterStats(containerPath: string): Promise<RasterStats> {
  const info = await gisJson<{ size: number[]; bands: { metadata?: Record<string, Record<string, string>> }[] }>(
    'gdalinfo', ['-json', '-stats', containerPath], { stderrLines: [] });
  const md = info.bands[0]?.metadata?.[''] ?? {};
  return {
    width: info.size[0] ?? 0, height: info.size[1] ?? 0,
    min: Number(md.STATISTICS_MINIMUM ?? NaN), max: Number(md.STATISTICS_MAXIMUM ?? NaN),
    validPct: Number(md.STATISTICS_VALID_PERCENT ?? 0),
  };
}

interface EsriPage {
  error?: { message: string };
  features?: unknown[];
  [key: string]: unknown;
}

interface ArcgisLayerInfo {
  error?: { message: string };
  objectIdField?: string;
  maxRecordCount?: number;
  description?: string;
  fields?: { name: string; type: string }[];
  editingInfo?: { dataLastEditDate?: number };
}
