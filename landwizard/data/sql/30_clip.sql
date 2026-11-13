-- Section 7, step 6: region boundary and overlay clip.
--
-- `region` holds one row: the union of all parcels (`geom`) and that boundary plus
-- 10 miles (`buf`), both in {{crs}}.
--
-- The union has many parts (Halifax: about 1,400, split by roads and unmapped gaps), and
-- one 16 km buffer of all of them needs more memory than Docker Desktop's default 4 GB
-- (the backend is killed). So the buffer runs in two stages: 500 m first, which merges
-- the parts into one polygon, then the rest of the 10 miles. Buffers by discs add up,
-- so the result is the same; each stage works on a simplified shape (50 m, then 100 m),
-- and the second stage adds 150 m to make up for that, so `buf` never falls short.
--
-- Each overlay present in staging is then moved to {{crs}} in place (polygons repaired
-- with ST_MakeValid), features outside `buf` are deleted, and the ones crossing its edge
-- are cut to it. Distances near the county edge stay right because the clip reaches
-- 10 miles past the last parcel. After this file every geometry in staging except
-- parcels_raw is in {{crs}}. Layers the region lacks are skipped; they stay absent.

CREATE TABLE region AS
SELECT ST_Multi(ST_CollectionExtract(ST_Union(geom), 3))::geometry(MultiPolygon, {{crs}}) AS geom
FROM parcels;

ALTER TABLE region ADD COLUMN buf geometry(MultiPolygon, {{crs}});
UPDATE region SET buf = ST_Multi(ST_Buffer(
  ST_SimplifyPreserveTopology(ST_Buffer(ST_SimplifyPreserveTopology(geom, 50), 500), 100),
  16093.44 - 500 + 150));

DO $$
DECLARE
  t text;
  kind text;
  dim int;
  n_in bigint;
  n_kept bigint;
  n_cut bigint;
  rep jsonb := '{}';
BEGIN
  RAISE NOTICE 'region: % sq mi of parcels; clip area % sq mi',
    (SELECT round((ST_Area(geom) / 2589988.11)::numeric) FROM region),
    (SELECT round((ST_Area(buf) / 2589988.11)::numeric) FROM region);

  FOR t, kind, dim IN
    SELECT * FROM (VALUES
      ('lines', 'MultiLineString', 2), ('osm_lines', 'MultiLineString', 2), ('substations', 'Point', 1),
      ('flood', 'MultiPolygon', 3), ('wetlands', 'MultiPolygon', 3),
      ('roads', 'MultiLineString', 2), ('waterways', 'MultiLineString', 2)) v(t, kind, dim)
  LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE NOTICE '%: unavailable, skipped', t;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n_in;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN geom TYPE geometry(%s, {{crs}}) USING %s', t, kind,
      CASE dim
        WHEN 3 THEN 'ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(geom, {{crs}})), 3))'
        ELSE 'ST_Transform(geom, {{crs}})'
      END);

    EXECUTE format('DELETE FROM %I o USING region r WHERE o.geom IS NULL OR ST_IsEmpty(o.geom) OR NOT ST_Intersects(o.geom, r.buf)', t);

    n_cut := 0;
    IF dim > 1 THEN
      EXECUTE format($q$
        UPDATE %I o SET geom = ST_Multi(ST_CollectionExtract(ST_Intersection(o.geom, r.buf), %s))
        FROM region r WHERE NOT ST_CoveredBy(o.geom, r.buf)
      $q$, t, dim);
      GET DIAGNOSTICS n_cut = ROW_COUNT;
      EXECUTE format('DELETE FROM %I WHERE ST_IsEmpty(geom)', t);
    END IF;
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n_kept;

    EXECUTE format('CREATE INDEX ON %I USING gist (geom)', t);
    EXECUTE format('ANALYZE %I', t);

    rep := rep || jsonb_build_object(t, jsonb_build_object('loaded', n_in, 'kept', n_kept, 'cut', n_cut));
    RAISE NOTICE '%: % of % features within the region + 10 mi, % cut at its edge', t, n_kept, n_in, n_cut;
  END LOOP;

  INSERT INTO meta VALUES ('clip', rep);
END
$$;
