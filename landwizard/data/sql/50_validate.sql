-- Section 7, step 9 (T-07): validate the build, report acreage, pick spot-check parcels.
--
-- Every check counts the rows that break it; any non-zero count stops the build
-- (RAISE EXCEPTION rolls this file back and build.ts exits 1), listing all failures at
-- once. Checks:
--   rows       parcels = source rows - empty ids - merged duplicates - empty geometries
--   metrics    one metrics row per parcel, no more, no less
--   geometry   every parcel valid, non-empty, with positive area
--   distances  none negative, none over 10 miles; nearest of a higher voltage class never closer than a lower
--              one (dl <= dl100 <= dl230 <= dl345, ds <= ds100 <= ds230)
--   shares     fl, wl, wb, st, cr, pa, fo in 0..1; cr + pa + fo <= 1; wb >= wl; sm in 0..90
--   acres      acres > 0; 0 <= ba <= acres
--   roads      ra in 0, 1, 2
--   blocks     obn and oba equal the count and acres of the block's parcels
--   points     lon, lat inside the region's bbox
--   nulls      a metric is null only when its layer is missing; distances are also null
--              past 10 miles (40_metrics.sql), so they are checked for that instead
--
-- Acreage report (never fails): for each numeric source column whose name contains ACRE,
-- the share of parcels whose computed acres differ from it by more than 20%, for all
-- parcels and for parcels of 5 acres and more (assessor acreage is often rounded to
-- whole acres, which skews small lots). A hint for the methodology note.
--
-- Spot check: table spot_check holds 5 parcels picked to exercise different metrics, for
-- a manual check in QGIS (T-07). build.ts exports it to raw/<region>/derived/spotcheck.gpkg.

DO $$
DECLARE
  idf jsonb := (SELECT value FROM meta WHERE key = 'identify');
  cln jsonb := (SELECT value FROM meta WHERE key = 'clean');
  bbox jsonb := (SELECT value -> 'bbox' FROM meta WHERE key = 'detected');
  expected bigint;
  failures text[] := '{}';
  n bigint;
  r record;
  rep jsonb := '{}';
  col text;
  j jsonb;
  eps float8 := 1e-9;
BEGIN
  expected := (idf->>'source_rows')::bigint - (idf->>'empty_id')::bigint - (idf->>'merged_rows')::bigint - (cln->>'empty_geom')::bigint;
  n := (SELECT count(*) FROM parcels);
  IF n <> expected THEN
    failures := array_append(failures, format('rows: %s parcels, expected %s (%s source - %s empty id - %s merged - %s empty geometry)',
      n, expected, idf->>'source_rows', idf->>'empty_id', idf->>'merged_rows', cln->>'empty_geom'));
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('metrics: parcels without a metrics row',
       (SELECT count(*) FROM parcels p WHERE NOT EXISTS (SELECT 1 FROM metrics m WHERE m.id = p.id))),
      ('metrics: metrics rows without a parcel',
       (SELECT count(*) FROM metrics m WHERE NOT EXISTS (SELECT 1 FROM parcels p WHERE p.id = m.id))),
      ('geometry: invalid, empty or zero-area parcels',
       (SELECT count(*) FROM parcels WHERE geom IS NULL OR ST_IsEmpty(geom) OR NOT (ST_IsValidDetail(geom)).valid OR ST_Area(geom) <= 0)),
      ('distances: over the 10-mile clip radius (should be null)',
       (SELECT count(*) FROM metrics WHERE GREATEST(dl, dl100, dl230, dl345, ds, ds100, ds230) > 10)),
      ('distances: negative',
       (SELECT count(*) FROM metrics WHERE LEAST(dl, dl100, dl230, dl345, ds, ds100, ds230) < 0)),
      ('distances: a higher voltage class closer than a lower one',
       (SELECT count(*) FROM metrics WHERE dl100 < dl - eps OR dl230 < dl100 - eps OR dl345 < dl230 - eps
                                        OR ds100 < ds - eps OR ds230 < ds100 - eps)),
      ('shares: outside 0..1',
       (SELECT count(*) FROM metrics WHERE LEAST(fl, wl, wb, st, cr, pa, fo) < 0 OR GREATEST(fl, wl, wb, st, cr, pa, fo) > 1)),
      ('shares: cropland + pasture + forest over 1',
       (SELECT count(*) FROM metrics WHERE cr + pa + fo > 1 + 1e-6)),
      ('shares: buffered water share below wetland share',
       (SELECT count(*) FROM metrics WHERE wb < wl - 1e-6)),
      ('shares: mean slope outside 0..90 degrees',
       (SELECT count(*) FROM metrics WHERE sm < 0 OR sm > 90)),
      ('acres: zero or negative',
       (SELECT count(*) FROM metrics WHERE acres IS NULL OR acres <= 0)),
      ('acres: buildable acres negative or above acres',
       (SELECT count(*) FROM metrics WHERE ba < 0 OR ba > acres + eps)),
      ('roads: road access not 0, 1 or 2',
       (SELECT count(*) FROM metrics WHERE ra NOT IN (0, 1, 2))),
      ('blocks: obn or oba differs from the block''s parcels',
       (SELECT count(*) FROM (SELECT ob FROM metrics WHERE ob IS NOT NULL GROUP BY ob
                              HAVING count(*) <> max(obn) OR count(DISTINCT obn) > 1
                                  OR abs(sum(acres) - max(oba)) > 1e-6 OR count(DISTINCT oba) > 1) b)),
      ('blocks: ob, obn, oba not all set or all null',
       (SELECT count(*) FROM metrics WHERE (ob IS NULL) <> (obn IS NULL) OR (ob IS NULL) <> (oba IS NULL))),
      ('points: lon, lat outside the region bbox',
       (SELECT count(*) FROM metrics WHERE lon IS NULL OR lat IS NULL
          OR lon < (bbox->>0)::float8 - 1e-4 OR lat < (bbox->>1)::float8 - 1e-4
          OR lon > (bbox->>2)::float8 + 1e-4 OR lat > (bbox->>3)::float8 + 1e-4))
    ) v(name, bad)
  LOOP
    IF r.bad > 0 THEN failures := array_append(failures, format('%s: %s parcels', r.name, r.bad)); END IF;
  END LOOP;

  -- Null only when the layer is missing.
  FOR r IN
    SELECT * FROM (VALUES
      ('ra', 'roads'), ('fl', 'flood'), ('wl', 'wetlands'),
      ('st', 'steep'), ('sm', 'slope_mean'), ('cr', 'landcover'), ('pa', 'landcover'), ('fo', 'landcover'),
      ('ba', 'parcels'), ('acres', 'parcels')) v(metric, layer)
  LOOP
    IF to_regclass(r.layer) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM metrics WHERE %I IS NULL', r.metric) INTO n;
      IF n > 0 THEN failures := array_append(failures, format('nulls: %s is null for %s parcels although %s is loaded', r.metric, n, r.layer)); END IF;
    END IF;
  END LOOP;
  IF to_regclass('waterways') IS NOT NULL OR to_regclass('wetlands') IS NOT NULL THEN
    n := (SELECT count(*) FROM metrics WHERE wb IS NULL);
    IF n > 0 THEN failures := array_append(failures, format('nulls: wb is null for %s parcels although water layers are loaded', n)); END IF;
  END IF;
  IF to_regclass('owner_key') IS NOT NULL THEN
    n := (SELECT count(*) FROM metrics WHERE ob IS NULL);
    IF n > 0 THEN failures := array_append(failures, format('nulls: ob is null for %s parcels although owner keys exist', n)); END IF;
  END IF;

  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION E'validation failed:\n  %', array_to_string(failures, E'\n  ');
  END IF;
  RAISE NOTICE 'validate: all checks passed for % parcels', (SELECT count(*) FROM parcels);

  -- Acreage report.
  FOR col IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'parcels' AND column_name ILIKE '%ACRE%'
      AND data_type IN ('double precision', 'real', 'numeric', 'integer', 'bigint', 'smallint')
    ORDER BY column_name
  LOOP
    EXECUTE format($q$
      SELECT jsonb_build_object(
        'filled', count(*),
        'off20', round(avg((abs(m.acres - p.%1$I) > 0.2 * p.%1$I)::int)::numeric, 3),
        'filled_5ac', count(*) FILTER (WHERE m.acres >= 5),
        'off20_5ac', round((avg((abs(m.acres - p.%1$I) > 0.2 * p.%1$I)::int) FILTER (WHERE m.acres >= 5))::numeric, 3),
        'whole', round(avg((p.%1$I = round(p.%1$I))::int)::numeric, 3),
        'sum', round(sum(p.%1$I)::numeric), 'computed_sum', round(sum(m.acres)::numeric))
      FROM parcels p JOIN metrics m USING (id) WHERE p.%1$I > 0
    $q$, col) INTO j;
    rep := rep || jsonb_build_object(col, j);
    RAISE NOTICE 'acreage vs %: % of % parcels differ by more than 20%% (% of parcels of 5+ ac); % whole numbers; % vs % computed acres',
      col, round(((j->>'off20')::numeric) * 100, 1) || '%', j->'filled',
      round(((j->>'off20_5ac')::numeric) * 100, 1) || '%',
      round(((j->>'whole')::numeric) * 100) || '%',
      j->'sum', j->'computed_sum';
  END LOOP;
  IF rep = '{}' THEN RAISE NOTICE 'acreage: no numeric *ACRE* column to compare with'; END IF;
  INSERT INTO meta VALUES ('validate', jsonb_build_object('passed', true, 'acreage', rep));
END
$$;

-- Spot check: 5 parcels, each chosen for a different metric, ids ordered for determinism.
CREATE TABLE spot_check AS
WITH m AS (SELECT * FROM metrics),
picks AS (
  (SELECT 1 AS n, 'floodplain farm: 100-500 ac, most flood share' AS why, id FROM m
   WHERE acres BETWEEN 100 AND 500 ORDER BY fl DESC NULLS LAST, id LIMIT 1)
  UNION ALL
  -- Not the closest: that is usually the substation's own lot, at distance 0.
  (SELECT 2, 'near a 230 kV substation: 20+ ac, nearest at 0.5 mi or more', id FROM m
   WHERE acres >= 20 AND ds230 >= 0.5 ORDER BY ds230, id LIMIT 1)
  UNION ALL
  (SELECT 3, 'possibly landlocked: largest parcel with no road within 30 m', id FROM m
   WHERE ra = 0 ORDER BY acres DESC, id LIMIT 1)
  UNION ALL
  (SELECT 4, 'owner block: 3-10 parcels, largest block, its biggest parcel', id FROM m
   WHERE obn BETWEEN 3 AND 10 ORDER BY oba DESC, acres DESC, id LIMIT 1)
  UNION ALL
  (SELECT 5, 'steep ground: 10+ ac, most steep share', id FROM m
   WHERE acres >= 10 ORDER BY st DESC NULLS LAST, id LIMIT 1)
)
SELECT k.n, k.why, m.*, p.geom
FROM picks k JOIN m USING (id) JOIN parcels p USING (id)
ORDER BY k.n;
