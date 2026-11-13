-- Section 7, step 8 (T-06, T-33): per-parcel metrics in the measuring projection.
--
-- metrics (one row per parcel, keyed by id; later steps add columns to it):
--   acres    ST_Area / 4046.856
--   dl       miles to the nearest power line of any voltage: HIFLD lines (100 kV and up)
--            plus every OSM power=line|minor_line. OSM lines of 100 kV and up are kept
--            too, although most repeat HIFLD: HIFLD misses some (Halifax: the 115 kV
--            lines into Scotland Neck, Sam's Head and Dawson's Crossroads substations;
--            without OSM's copy 3,938 parcels around them read over 10 mi from any line).
--            Duplicates can't distort a nearest distance.
--   dl100, dl230, dl345
--            the same, counting only lines of at least 100, 230, 345 kV: HIFLD by VOLTAGE
--            (or the low end of VOLT_CLASS when VOLTAGE is unknown, -999999), OSM by max_kv
--            (scripts/voltage.ts: highest circuit of tags such as `230000;115000;?`). OSM
--            lines with no readable voltage count for dl only. Null when no such line lies
--            within 10 miles (Halifax has one 500 kV line and no 345 kV one).
--   ds       miles to the nearest substation, leaving out OSM `substation=generation` and
--            `industrial` (private collector or plant stations); null without substations
--   ds100, ds230
--            the same, counting only substations of at least 100, 230 kV by max_kv;
--            substations without a voltage tag count for ds only
--   ra       road access (F-33): 2 when an OSM road open to the public lies within 30 m of
--            the parcel (the parcel line usually ends at the right-of-way, not the
--            centerline), 1 when only a track, service road or private road does, else 0
--            ("possibly landlocked"). Public: trunk, primary, secondary, tertiary,
--            unclassified, residential, living_street, road and their _link ramps, unless
--            access or motor_vehicle closes them (private, no, customers, permit,
--            agricultural, forestry, delivery, military). Motorways count for nothing:
--            they are controlled-access, so no land is reached from them. Footways, paths
--            and other non-vehicle ways are ignored. Null when the region has no OSM roads.
--   fl       share of the parcel inside a FEMA special flood hazard area (SFHA_TF = 'T':
--            zones A, AE, AH, AO, V, VE, floodways); 0.2% and minimal-hazard zone X don't
--            count; null when the region has no NFHL
--   wl       share inside an NWI wetland: water types (Riverine, Lake, Freshwater Pond,
--            Estuarine and Marine Deepwater) are left out, as they are open water that the
--            buffered water share (wb, T-34) counts; null when the region has no NWI
--   lon, lat ST_PointOnSurface in WGS84, for the CSV and the results list
--
-- Distances are polygon edge to nearest feature (0 when they touch), found with the KNN
-- operator `<->` on GiST indexes. Values are stored unrounded; export.ts rounds them.
--
-- Distances are exact only up to 10 miles: 30_clip.sql keeps overlay features within
-- 10 miles of the region, so a nearer feature farther out may be missing (found in the
-- T-07 QGIS spot check: a 230 kV substation at 17.1 mi outside the clip, while the build
-- reported one at 18.3 mi inside it). Any distance over 10 miles is therefore stored as
-- null, read as "none within 10 miles", like a class with no feature at all.
--
-- Helper tables kept for the later metric steps (buffered water, buildable acres):
--   flood_sfha   SFHA polygons, subdivided to at most 256 vertices per piece
--   nwi_sub      NWI polygons, subdivided, with is_water
-- Subdividing keeps each parcel's overlay to a few small pieces instead of whole floodplains.

CREATE TABLE metrics AS
SELECT id,
       ST_Area(geom) / 4046.856 AS acres,
       ST_X(ST_Transform(ST_PointOnSurface(geom), 4326)) AS lon,
       ST_Y(ST_Transform(ST_PointOnSurface(geom), 4326)) AS lat
FROM parcels;
ALTER TABLE metrics ADD PRIMARY KEY (id);
ALTER TABLE metrics
  ADD COLUMN dl float8, ADD COLUMN dl100 float8, ADD COLUMN dl230 float8, ADD COLUMN dl345 float8,
  ADD COLUMN ds float8, ADD COLUMN ds100 float8, ADD COLUMN ds230 float8,
  ADD COLUMN ra smallint, ADD COLUMN fl float8, ADD COLUMN wl float8;

-- Lines of every source with their voltage in kV (null = unknown), cut into pieces of at
-- most 32 vertices. A power line is a few long features whose bounding boxes cover half
-- the county, so the KNN index can't rule them out; the pieces give the same nearest
-- distance about 5x faster.
CREATE TEMP TABLE power_lines ON COMMIT DROP AS
SELECT CASE WHEN voltage > 0 THEN voltage ELSE substring(volt_class FROM '^\d+')::float8 END AS kv,
       ST_Subdivide(geom, 32) AS geom
FROM lines;

DO $$
DECLARE
  has_osm boolean := to_regclass('osm_lines') IS NOT NULL;
  has_subs boolean := to_regclass('substations') IS NOT NULL;
  has_roads boolean := to_regclass('roads') IS NOT NULL;
  has_flood boolean := to_regclass('flood') IS NOT NULL;
  has_nwi boolean := to_regclass('wetlands') IS NOT NULL;
  s jsonb;
BEGIN
  IF has_osm THEN
    INSERT INTO power_lines SELECT max_kv, ST_Subdivide(geom, 32) FROM osm_lines;
  END IF;
  CREATE INDEX ON power_lines USING gist (geom);
  ANALYZE power_lines;

  -- One indexed table per voltage class: a KNN scan with a voltage filter instead would
  -- compute exact distances to nearly every line before reaching a rare 345 kV one
  -- (about 3x slower).
  CREATE TEMP TABLE pl100 ON COMMIT DROP AS SELECT geom FROM power_lines WHERE kv >= 100;
  CREATE TEMP TABLE pl230 ON COMMIT DROP AS SELECT geom FROM power_lines WHERE kv >= 230;
  CREATE TEMP TABLE pl345 ON COMMIT DROP AS SELECT geom FROM power_lines WHERE kv >= 345;
  CREATE INDEX ON pl100 USING gist (geom);
  CREATE INDEX ON pl230 USING gist (geom);
  CREATE INDEX ON pl345 USING gist (geom);
  ANALYZE pl100; ANALYZE pl230; ANALYZE pl345;

  UPDATE metrics m SET dl = a.d, dl100 = b.d, dl230 = c.d, dl345 = e.d
  FROM parcels p
  LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, l.geom) / 1609.344 AS d FROM power_lines l
                     ORDER BY p.geom <-> l.geom LIMIT 1) a ON true
  LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, l.geom) / 1609.344 AS d FROM pl100 l
                     ORDER BY p.geom <-> l.geom LIMIT 1) b ON true
  LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, l.geom) / 1609.344 AS d FROM pl230 l
                     ORDER BY p.geom <-> l.geom LIMIT 1) c ON true
  LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, l.geom) / 1609.344 AS d FROM pl345 l
                     ORDER BY p.geom <-> l.geom LIMIT 1) e ON true
  WHERE p.id = m.id;

  IF has_subs THEN
    CREATE TEMP TABLE subs ON COMMIT DROP AS
    SELECT max_kv AS kv, geom FROM substations WHERE substation IS NULL OR substation NOT IN ('generation', 'industrial');
    CREATE TEMP TABLE subs100 ON COMMIT DROP AS SELECT geom FROM subs WHERE kv >= 100;
    CREATE TEMP TABLE subs230 ON COMMIT DROP AS SELECT geom FROM subs WHERE kv >= 230;
    CREATE INDEX ON subs USING gist (geom);
    CREATE INDEX ON subs100 USING gist (geom);
    CREATE INDEX ON subs230 USING gist (geom);
    ANALYZE subs; ANALYZE subs100; ANALYZE subs230;

    UPDATE metrics m SET ds = a.d, ds100 = b.d, ds230 = c.d
    FROM parcels p
    LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, s.geom) / 1609.344 AS d FROM subs s
                       ORDER BY p.geom <-> s.geom LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, s.geom) / 1609.344 AS d FROM subs100 s
                       ORDER BY p.geom <-> s.geom LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT ST_Distance(p.geom, s.geom) / 1609.344 AS d FROM subs230 s
                       ORDER BY p.geom <-> s.geom LIMIT 1) c ON true
    WHERE p.id = m.id;
  END IF;

  -- Over 10 miles: not reliable past the clip radius (see the header), so null.
  UPDATE metrics SET
    dl = CASE WHEN dl > 10 THEN NULL ELSE dl END, dl100 = CASE WHEN dl100 > 10 THEN NULL ELSE dl100 END,
    dl230 = CASE WHEN dl230 > 10 THEN NULL ELSE dl230 END, dl345 = CASE WHEN dl345 > 10 THEN NULL ELSE dl345 END,
    ds = CASE WHEN ds > 10 THEN NULL ELSE ds END, ds100 = CASE WHEN ds100 > 10 THEN NULL ELSE ds100 END,
    ds230 = CASE WHEN ds230 > 10 THEN NULL ELSE ds230 END
  WHERE GREATEST(dl, dl100, dl230, dl345, ds, ds100, ds230) > 10;

  IF has_roads THEN
    CREATE TEMP TABLE road_access ON COMMIT DROP AS
    SELECT CASE
             WHEN highway IN ('service', 'track') THEN 1
             WHEN lower(access) IN ('private', 'no', 'customers', 'permit', 'agricultural', 'forestry', 'delivery', 'military')
               OR lower(motor_vehicle) IN ('private', 'no', 'customers', 'permit', 'agricultural', 'forestry', 'delivery', 'military')
               THEN 1
             ELSE 2
           END AS cls,
           geom
    FROM roads
    WHERE highway IN ('trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'road',
                      'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'service', 'track');
    CREATE INDEX ON road_access USING gist (geom);
    ANALYZE road_access;

    UPDATE metrics m SET ra = CASE
        WHEN EXISTS (SELECT 1 FROM road_access r WHERE r.cls = 2 AND ST_DWithin(p.geom, r.geom, 30)) THEN 2
        WHEN EXISTS (SELECT 1 FROM road_access r WHERE ST_DWithin(p.geom, r.geom, 30)) THEN 1
        ELSE 0 END
    FROM parcels p WHERE p.id = m.id;
  END IF;

  IF has_flood THEN
    CREATE TABLE flood_sfha AS
    SELECT fld_zone, ST_Subdivide(geom, 256) AS geom FROM flood WHERE sfha_tf = 'T';
    CREATE INDEX ON flood_sfha USING gist (geom);
    ANALYZE flood_sfha;

    -- Union of the clipped pieces, so overlapping source polygons are counted once.
    UPDATE metrics m SET fl = COALESCE(x.a, 0) / ST_Area(p.geom)
    FROM parcels p
    LEFT JOIN LATERAL (
      SELECT ST_Area(ST_Union(ST_Intersection(p.geom, f.geom))) AS a
      FROM flood_sfha f WHERE ST_Intersects(p.geom, f.geom)
    ) x ON true
    WHERE p.id = m.id;
  END IF;

  IF has_nwi THEN
    CREATE TABLE nwi_sub AS
    SELECT wetland_type,
           wetland_type IN ('Riverine', 'Lake', 'Freshwater Pond', 'Estuarine and Marine Deepwater') AS is_water,
           ST_Subdivide(geom, 256) AS geom
    FROM wetlands;
    CREATE INDEX ON nwi_sub USING gist (geom);
    ANALYZE nwi_sub;

    UPDATE metrics m SET wl = COALESCE(x.a, 0) / ST_Area(p.geom)
    FROM parcels p
    LEFT JOIN LATERAL (
      SELECT ST_Area(ST_Union(ST_Intersection(p.geom, w.geom))) AS a
      FROM nwi_sub w WHERE NOT w.is_water AND ST_Intersects(p.geom, w.geom)
    ) x ON true
    WHERE p.id = m.id;
  END IF;

  -- Rounding noise can push a share a hair over 1.
  UPDATE metrics SET fl = LEAST(fl, 1), wl = LEAST(wl, 1) WHERE fl > 1 OR wl > 1;

  SELECT jsonb_object_agg(k, v) INTO s FROM (
    SELECT 'parcels' k, to_jsonb(count(*)) v FROM metrics
    UNION ALL SELECT 'acres', to_jsonb(round(sum(acres)::numeric)) FROM metrics
    UNION ALL SELECT 'dl_median', to_jsonb(round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dl))::numeric, 2)) FROM metrics
    UNION ALL SELECT 'ds_median', to_jsonb(round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ds))::numeric, 2)) FROM metrics
    UNION ALL SELECT 'fl_any', to_jsonb(count(*) FILTER (WHERE fl > 0)) FROM metrics
    UNION ALL SELECT 'wl_any', to_jsonb(count(*) FILTER (WHERE wl > 0)) FROM metrics
    UNION ALL SELECT k, to_jsonb(round((percentile_cont(0.5) WITHIN GROUP (ORDER BY d))::numeric, 2))
      FROM metrics, LATERAL (VALUES ('dl100_median', dl100), ('dl230_median', dl230), ('dl345_median', dl345),
                                    ('ds100_median', ds100), ('ds230_median', ds230)) v(k, d)
      GROUP BY k
    UNION ALL SELECT 'ra_' || ra, to_jsonb(count(*)) FROM metrics WHERE ra IS NOT NULL GROUP BY ra
  ) t;
  INSERT INTO meta VALUES ('metrics', s);

  RAISE NOTICE 'metrics: % parcels, % acres; median % mi to a line, % mi to a substation',
    s->'parcels', s->'acres', s->'dl_median', COALESCE(s->>'ds_median', 'n/a');
  RAISE NOTICE 'metrics: % parcels touch a flood hazard area, % a wetland%',
    CASE WHEN has_flood THEN s->>'fl_any' ELSE 'n/a (no NFHL)' END,
    CASE WHEN has_nwi THEN s->>'wl_any' ELSE 'n/a (no NWI)' END,
    CASE WHEN has_subs THEN '' ELSE '; no substations, ds is null' END;
  RAISE NOTICE 'metrics: median mi to a line of 100+ kV %, 230+ %, 345+ %; to a substation of 100+ kV %, 230+ %',
    COALESCE(s->>'dl100_median', 'none'), COALESCE(s->>'dl230_median', 'none'), COALESCE(s->>'dl345_median', 'none'),
    COALESCE(s->>'ds100_median', 'none'), COALESCE(s->>'ds230_median', 'none');
  IF has_roads THEN
    RAISE NOTICE 'metrics: road access: % public road, % track or private only, % none (possibly landlocked)',
      COALESCE(s->>'ra_2', '0'), COALESCE(s->>'ra_1', '0'), COALESCE(s->>'ra_0', '0');
  ELSE
    RAISE NOTICE 'metrics: no OSM roads, ra is null';
  END IF;
END
$$;
