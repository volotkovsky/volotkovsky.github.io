-- Section 7, step 8 (T-35): buildable acres (F-31), added to `metrics`.
--
--   ba   acres left after shrinking the parcel inward by --setback-ft ({{setback_m}} m) and
--        taking out the flood hazard area (flood_sfha), wetlands and water with their buffer
--        (water_buf, built with --water-buffer-ft) and ground steeper than 5 degrees
--        (steep_sub). Overlapping constraints are unioned per parcel, so they count once.
--        A parcel narrower than twice the setback has ba = 0. Constraint layers the
--        region lacks are skipped (the methodology note says which ones applied).
--
-- Computed as area(core) - area(union of constraints inside core), which equals
-- ST_Area(ST_Difference(core, constraints)) without building the difference geometry.

ALTER TABLE metrics ADD COLUMN ba float8;

DO $$
DECLARE
  setback float8 := {{setback_m}};
  used text[] := '{}';
  s jsonb;
BEGIN
  CREATE TEMP TABLE constraints (geom geometry) ON COMMIT DROP;
  IF to_regclass('flood_sfha') IS NOT NULL THEN
    INSERT INTO constraints SELECT geom FROM flood_sfha;
    used := array_append(used, 'flood');
  END IF;
  IF to_regclass('water_buf') IS NOT NULL THEN
    INSERT INTO constraints SELECT geom FROM water_buf;
    used := array_append(used, 'water');
  END IF;
  IF to_regclass('steep_sub') IS NOT NULL THEN
    INSERT INTO constraints SELECT geom FROM steep_sub;
    used := array_append(used, 'steep');
  END IF;
  CREATE INDEX ON constraints USING gist (geom);
  ANALYZE constraints;

  UPDATE metrics m SET ba = GREATEST(ST_Area(c.core) - COALESCE(x.a, 0), 0) / 4046.856
  FROM parcels p
  CROSS JOIN LATERAL (SELECT ST_Buffer(p.geom, -setback) AS core) c
  LEFT JOIN LATERAL (
    SELECT ST_Area(ST_Union(ST_Intersection(c.core, k.geom))) AS a
    FROM constraints k WHERE ST_Intersects(c.core, k.geom)
  ) x ON true
  WHERE p.id = m.id;

  -- ba can't exceed acres; guard against float noise on parcels with no constraints.
  UPDATE metrics SET ba = acres WHERE ba > acres;

  SELECT jsonb_build_object(
    'setback_m', setback, 'constraints', to_jsonb(used),
    'ba', round(sum(ba)::numeric), 'acres', round(sum(acres)::numeric),
    'ba_zero', count(*) FILTER (WHERE ba = 0),
    'ba_100_500', count(*) FILTER (WHERE acres BETWEEN 100 AND 500 AND ba >= 50)) INTO s
  FROM metrics;
  INSERT INTO meta VALUES ('buildable', s);

  RAISE NOTICE 'buildable: % of % acres (% m setback; minus %); % parcels have none; % parcels of 100-500 ac keep 50+ buildable',
    s->'ba', s->'acres', round(setback::numeric, 2), array_to_string(used, ', '), s->'ba_zero', s->'ba_100_500';
END
$$;
