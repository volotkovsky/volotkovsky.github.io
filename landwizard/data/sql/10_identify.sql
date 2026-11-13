-- Section 7, step 4: identify parcels.
--
-- parcels_raw -> parcels: the --id column becomes `id` (text, trimmed), rows with an
-- empty id are dropped, and rows sharing an id are merged into one multipolygon
-- (ST_Union), keeping the attributes of the largest piece. Every other source column is
-- kept under its source name; geometry stays EPSG:4326 until 20_clean.sql.
--
-- The counts go to meta.identify (read by 50_validate.sql) and are printed.

DO $$
DECLARE
  idcol text := (SELECT value #>> '{}' FROM meta WHERE key = 'id_column');
  cols text;
  s jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'parcels_raw'
               AND column_name = 'id' AND column_name <> idcol) THEN
    RAISE EXCEPTION 'the parcel file has a column named "id" that is not the --id column (%); rename it in the source', idcol;
  END IF;

  SELECT string_agg(format('r.%I', column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'parcels_raw'
    AND column_name NOT IN (idcol, 'ogc_fid', 'geom');

  EXECUTE format($q$
    CREATE TEMP TABLE keyed ON COMMIT DROP AS
    SELECT r.ogc_fid, NULLIF(btrim(r.%I::text), '') AS id,
           ST_Area(ST_Transform(r.geom, {{crs}})) AS area
    FROM parcels_raw r
  $q$, idcol);

  CREATE TEMP TABLE id_groups ON COMMIT DROP AS
  SELECT id, count(*)::int AS n FROM keyed WHERE id IS NOT NULL GROUP BY id;

  -- Largest piece first; ties (and null geometries) fall back to file order.
  CREATE TEMP TABLE best ON COMMIT DROP AS
  SELECT DISTINCT ON (id) id, ogc_fid FROM keyed WHERE id IS NOT NULL
  ORDER BY id, area DESC NULLS LAST, ogc_fid;

  -- ST_MakeValid first: one invalid piece would otherwise stop the union.
  CREATE TEMP TABLE merged ON COMMIT DROP AS
  SELECT k.id, ST_Multi(ST_CollectionExtract(ST_Union(ST_MakeValid(r.geom)), 3)) AS geom
  FROM keyed k JOIN id_groups g ON g.id = k.id AND g.n > 1 JOIN parcels_raw r ON r.ogc_fid = k.ogc_fid
  GROUP BY k.id;

  EXECUTE format($q$
    CREATE TABLE parcels AS
    SELECT b.id, %s, COALESCE(m.geom, r.geom)::geometry(MultiPolygon, 4326) AS geom
    FROM best b
    JOIN parcels_raw r ON r.ogc_fid = b.ogc_fid
    LEFT JOIN merged m ON m.id = b.id
    ORDER BY b.id
  $q$, cols);
  ALTER TABLE parcels ADD PRIMARY KEY (id);

  s := jsonb_build_object(
    'source_rows', (SELECT count(*) FROM keyed),
    'empty_id',    (SELECT count(*) FROM keyed WHERE id IS NULL),
    'dup_ids',     (SELECT count(*) FROM id_groups WHERE n > 1),
    'merged_rows', (SELECT COALESCE(sum(n - 1), 0) FROM id_groups WHERE n > 1),
    'parcels',     (SELECT count(*) FROM parcels));
  INSERT INTO meta VALUES ('identify', s);

  RAISE NOTICE 'identify: % source rows; dropped % with an empty %; merged % rows into % ids sharing an id; % parcels',
    s->'source_rows', s->'empty_id', idcol, (s->>'merged_rows')::int + (s->>'dup_ids')::int, s->'dup_ids', s->'parcels';
END
$$;
