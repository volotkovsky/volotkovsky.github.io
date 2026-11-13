-- Section 7, step 5: clean parcels.
--
-- Geometry moves to the measuring projection ({{crs}}) and is repaired there
-- (ST_MakeValid, polygon parts only), so area and distance work on valid shapes;
-- parcels whose geometry is missing or ends up empty are dropped. Text columns are
-- trimmed, and blank values become NULL so "filled" counts and "field is empty" rules
-- see them as empty. From here on every parcel geometry is in {{crs}}.
--
-- The counts go to meta.clean (read by 50_validate.sql) and are printed.

DO $$
DECLARE
  n_invalid int;
  n_empty int;
  sets text;
BEGIN
  -- ST_IsValidDetail rather than ST_IsValid, which prints a NOTICE per invalid shape.
  SELECT count(*) INTO n_invalid FROM parcels WHERE geom IS NOT NULL AND NOT (ST_IsValidDetail(geom)).valid;

  ALTER TABLE parcels ALTER COLUMN geom TYPE geometry(MultiPolygon, {{crs}})
    USING ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(geom, {{crs}})), 3));

  DELETE FROM parcels WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Area(geom) = 0;
  GET DIAGNOSTICS n_empty = ROW_COUNT;

  SELECT string_agg(format('%1$I = NULLIF(btrim(%1$I, E'' \t\r\n''), '''')', column_name), ', ') INTO sets
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'parcels' AND column_name <> 'id'
    AND data_type IN ('character varying', 'text', 'character');
  IF sets IS NOT NULL THEN
    EXECUTE format('UPDATE parcels SET %s', sets);
  END IF;

  CREATE INDEX parcels_geom_idx ON parcels USING gist (geom);
  ANALYZE parcels;

  INSERT INTO meta VALUES ('clean', jsonb_build_object(
    'made_valid', n_invalid, 'empty_geom', n_empty, 'parcels', (SELECT count(*) FROM parcels)));
  RAISE NOTICE 'clean: repaired % invalid geometries; dropped % parcels with an empty geometry; % parcels',
    n_invalid, n_empty, (SELECT count(*) FROM parcels);
END
$$;
