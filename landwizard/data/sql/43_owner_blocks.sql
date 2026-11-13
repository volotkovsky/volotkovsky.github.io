-- Section 7, step 8 (T-35): owner blocks (F-32), added to `metrics`.
--
--   ob   block index: parcels with the same normalized owner (owner_key, from
--        scripts/owners.ts) that touch or lie within 30 m of each other, across a road or a
--        sliver, form one block (ST_ClusterDBSCAN, eps 30 m, minpoints 1, per owner key).
--        Numbered 1.. in order of the block's smallest parcel id, so reruns keep numbers.
--   obn  parcels in the block
--   oba  total acres of the block
-- A parcel with no owner name is a block of its own. All three are null when the build
-- has no owner column (no --owner and no single OWN*NAME column).
--
-- Owner names are not printed here: they are public record but kept out of logs and
-- screenshots (section 5).

ALTER TABLE metrics ADD COLUMN ob int, ADD COLUMN obn int, ADD COLUMN oba float8;

DO $$
DECLARE
  s jsonb;
BEGIN
  IF to_regclass('owner_key') IS NULL THEN
    RAISE NOTICE 'owner blocks: no owner column, ob, obn and oba stay null';
    RETURN;
  END IF;

  -- bk: the owner key, or the parcel's own id when it has no owner name.
  CREATE TEMP TABLE clustered ON COMMIT DROP AS
  SELECT id, bk, ST_ClusterDBSCAN(geom, eps := 30, minpoints := 1) OVER (PARTITION BY bk) AS c
  FROM (SELECT p.id, p.geom, COALESCE(k.key, '#' || p.id) AS bk FROM parcels p JOIN owner_key k USING (id)) x;

  CREATE TEMP TABLE blocks ON COMMIT DROP AS
  SELECT row_number() OVER (ORDER BY min(cl.id))::int AS ob, cl.bk, cl.c, count(*)::int AS n, sum(m.acres) AS acres
  FROM clustered cl JOIN metrics m USING (id)
  GROUP BY cl.bk, cl.c;

  UPDATE metrics m SET ob = b.ob, obn = b.n, oba = b.acres
  FROM clustered cl JOIN blocks b USING (bk, c)
  WHERE m.id = cl.id;

  SELECT jsonb_build_object(
    'blocks', count(*), 'multi', count(*) FILTER (WHERE n > 1),
    'parcels_in_multi', COALESCE(sum(n) FILTER (WHERE n > 1), 0),
    'largest_n', max(n), 'largest_acres', round(max(acres)::numeric),
    'blocks_500ac', count(*) FILTER (WHERE acres >= 500 AND n > 1)) INTO s
  FROM blocks;
  INSERT INTO meta VALUES ('owner_blocks', s);

  RAISE NOTICE 'owner blocks: % blocks; % of them join % parcels; largest % parcels, largest % acres; % multi-parcel blocks of 500+ acres',
    s->'blocks', s->'multi', s->'parcels_in_multi', s->'largest_n', s->'largest_acres', s->'blocks_500ac';
END
$$;
