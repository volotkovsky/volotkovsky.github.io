-- Section 7, step 8 (T-34): water, terrain and land-cover shares, added to `metrics`.
--
--   wb   share inside wetlands, NWI open water (all NWI types) and OSM waterways, each
--        buffered by --water-buffer-ft ({{water_buffer_m}} m). Streams are lines, so with a
--        buffer of 0 they add nothing. Null when the region has neither NWI nor waterways.
--   st   share steeper than 5 degrees (polygons from the raster step); null without a DEM
--   sm   mean slope in degrees, area-weighted (raster step, gdal raster zonal-stats)
--   cr, pa, fo
--        cropland, pasture and hay, forest share (Cropland Data Layer polygons); null
--        outside its coverage. These need not add up to 1: shrubland, developed land,
--        water and wetland classes are in no group.
--
-- Helper tables kept for buildable acres (T-35):
--   water_buf    buffered NWI and waterways, subdivided; pieces overlap, so shares use a
--                per-parcel union
--   steep_sub    steep polygons, made valid and subdivided
--
-- The raster polygons tile the grid without overlap, so st, cr, pa and fo sum the
-- intersections; the buffered water overlaps itself and is unioned per parcel.

ALTER TABLE metrics ADD COLUMN wb float8, ADD COLUMN st float8, ADD COLUMN sm float8,
  ADD COLUMN cr float8, ADD COLUMN pa float8, ADD COLUMN fo float8;

DO $$
DECLARE
  buf float8 := {{water_buffer_m}};
  has_nwi boolean := to_regclass('nwi_sub') IS NOT NULL;
  has_ww boolean := to_regclass('waterways') IS NOT NULL;
  has_steep boolean := to_regclass('steep') IS NOT NULL;
  has_slope boolean := to_regclass('slope_mean') IS NOT NULL;
  has_lc boolean := to_regclass('landcover') IS NOT NULL;
  s jsonb;
BEGIN
  IF has_nwi OR has_ww THEN
    CREATE TABLE water_buf (src text, geom geometry(Geometry, {{crs}}));
    IF has_nwi THEN
      INSERT INTO water_buf
      SELECT 'nwi', ST_Subdivide(ST_Buffer(geom, buf), 256) FROM nwi_sub;
    END IF;
    IF has_ww AND buf > 0 THEN
      INSERT INTO water_buf
      SELECT 'waterway', ST_Subdivide(ST_Buffer(geom, buf), 256) FROM waterways;
    END IF;
    CREATE INDEX ON water_buf USING gist (geom);
    ANALYZE water_buf;

    UPDATE metrics m SET wb = LEAST(COALESCE(x.a, 0) / ST_Area(p.geom), 1)
    FROM parcels p
    LEFT JOIN LATERAL (
      SELECT ST_Area(ST_Union(ST_Intersection(p.geom, w.geom))) AS a
      FROM water_buf w WHERE ST_Intersects(p.geom, w.geom)
    ) x ON true
    WHERE p.id = m.id;
  END IF;

  IF has_steep THEN
    CREATE TABLE steep_sub AS
    SELECT ST_Subdivide(g, 256)::geometry(Geometry, {{crs}}) AS geom
    FROM (SELECT (ST_Dump(ST_CollectionExtract(ST_MakeValid(geom), 3))).geom AS g FROM steep) d;
    CREATE INDEX ON steep_sub USING gist (geom);
    ANALYZE steep_sub;

    UPDATE metrics m SET st = LEAST(COALESCE(x.a, 0) / ST_Area(p.geom), 1)
    FROM parcels p
    LEFT JOIN LATERAL (
      SELECT sum(ST_Area(ST_Intersection(p.geom, t.geom))) AS a
      FROM steep_sub t WHERE ST_Intersects(p.geom, t.geom)
    ) x ON true
    WHERE p.id = m.id;
  END IF;

  IF has_slope THEN
    UPDATE metrics m SET sm = z.mean FROM slope_mean z WHERE z.id = m.id;
  END IF;

  IF has_lc THEN
    CREATE TEMP TABLE lc_sub ON COMMIT DROP AS
    SELECT cls, ST_Subdivide(g, 256) AS geom
    FROM (SELECT cls, (ST_Dump(ST_CollectionExtract(ST_MakeValid(geom), 3))).geom AS g FROM landcover) d;
    CREATE INDEX ON lc_sub USING gist (geom);
    ANALYZE lc_sub;

    UPDATE metrics m
    SET cr = LEAST(COALESCE(x.c, 0) / ST_Area(p.geom), 1),
        pa = LEAST(COALESCE(x.h, 0) / ST_Area(p.geom), 1),
        fo = LEAST(COALESCE(x.f, 0) / ST_Area(p.geom), 1)
    FROM parcels p
    LEFT JOIN LATERAL (
      SELECT sum(a) FILTER (WHERE cls = 1) AS c, sum(a) FILTER (WHERE cls = 2) AS h, sum(a) FILTER (WHERE cls = 3) AS f
      FROM (SELECT l.cls, ST_Area(ST_Intersection(p.geom, l.geom)) AS a
            FROM lc_sub l WHERE ST_Intersects(p.geom, l.geom)) i
    ) x ON true
    WHERE p.id = m.id;
  END IF;

  -- Acre-weighted means over the county, as a plausibility check.
  SELECT jsonb_build_object(
    'water_buffer_m', buf,
    'wb', round((sum(wb * acres) / sum(acres))::numeric, 3),
    'st', round((sum(st * acres) / sum(acres))::numeric, 3),
    'sm', round((sum(sm * acres) / sum(acres))::numeric, 2),
    'cr', round((sum(cr * acres) / sum(acres))::numeric, 3),
    'pa', round((sum(pa * acres) / sum(acres))::numeric, 3),
    'fo', round((sum(fo * acres) / sum(acres))::numeric, 3),
    'sm_null', count(*) FILTER (WHERE sm IS NULL AND has_slope)) INTO s
  FROM metrics;
  INSERT INTO meta VALUES ('shares', s);

  RAISE NOTICE 'shares (acre-weighted): water with % m buffer %, steeper than 5 deg %, mean slope % deg',
    round(buf::numeric, 2), COALESCE(s->>'wb', 'n/a'), COALESCE(s->>'st', 'n/a'), COALESCE(s->>'sm', 'n/a');
  RAISE NOTICE 'shares (acre-weighted): cropland %, pasture and hay %, forest %',
    COALESCE(s->>'cr', 'n/a'), COALESCE(s->>'pa', 'n/a'), COALESCE(s->>'fo', 'n/a');
  IF (s->>'sm_null')::int > 0 THEN
    RAISE NOTICE 'shares: % parcels got no mean slope (outside the DEM?)', s->'sm_null';
  END IF;
END
$$;
