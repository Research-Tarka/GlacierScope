"""
serve.py
---------
Viewer HTTP server: serves the static files (index.html, src/, vendor/)
plus a small in-process API for per-glacier data.

ingest.py only builds index.json/sources.json/manifest.json up front (just
enough for the world map + variable picker labels) -- extracting every
glacier's geometry, DEM, and classification stack ahead of time was almost
all wasted work with 20k+ glaciers on the map and a handful ever clicked
per session, so this server does that extraction lazily instead, straight
from the source GeoPackage/tables/DEM tiles named in manifest.json, the
moment a glacier is actually requested, and keeps the result in memory for
the rest of the session:
  - source tables (meta/year_series) are scanned per request, filtered by
    id with the filter pushed into the parquet read itself -- no table is
    ever loaded whole into memory, so RAM stays proportional to glaciers
    actually clicked, not to the size of the source tables on disk
  - geometry (outline/geom_series) is pulled from the GeoPackage's single
    glacier_evolution layer with a query scoped to just that glacier's id,
    not the whole table
  - DEM comes from that glacier's own GeoTIFF under DEM_tiles/ (its own
    local CRS + rotated affine transform, read with rasterio); the
    per-pixel classification stack no longer ships pre-rasterized, so it's
    rebuilt on the spot by rasterizing that glacier's snow/ice/other/cloud
    polygons (from glacier_evolution) onto the DEM's own pixel grid, one
    year at a time

This needs packages ingest.py also uses (pyproj, rasterio, polars, shapely,
scipy) -- launch_viewer() in ingest.py starts it with sys.executable, i.e.
whichever interpreter ran ingest.py itself (normally the bundled runtime
under viewer/runtime/python, which has these packages pip-installed into
it; a conda env works the same way if that's what ran ingest.py instead).

Usage:
    python serve.py [port]
"""

import gzip
import re
import sqlite3
import sys
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

import numpy as np
import orjson
import polars as pl
from scipy.ndimage import (
    binary_dilation as ndimage_binary_dilation,
    label as ndimage_label,
    maximum as ndimage_maximum,
    minimum as ndimage_minimum,
    sum as ndimage_sum,
)

DATA_DIR = Path(__file__).resolve().parent / "data"
# Bumped to v2 when OUTSIDE_FOOTPRINT was split out of CLOUD_EXCLUDED (class
# 3 used to double as both "real cloud polygon" and "outside the glacier
# footprint") -- old .raster_cache/*.npz files hold sgv_stack values baked
# with the old, conflated classification and must not be reused as-is.
RASTER_CACHE_DIR = DATA_DIR / ".raster_cache_v2"
# gid is restricted to the character set real GLIMS-style glacier ids use
# (alnum, dot, underscore, hyphen) -- it's later used as a sqlite parameter
# (already safe) and as a filename component in RASTER_CACHE_DIR / f"{gid}.npz"
# (not safe on its own), so a request path must not be able to smuggle path
# separators or ".." through it.
GLACIER_PATH_RE = re.compile(r"^/data/glaciers/([A-Za-z0-9_.-]+)/(.+)$")
CLOUD_EXCLUDED = 3
OUTSIDE_FOOTPRINT = 4


def read_json(path: Path):
    return orjson.loads(path.read_bytes())


# --- Lazy, cached, in-memory state -----------------------------------------

_manifest = None


def manifest() -> dict:
    global _manifest
    if _manifest is None:
        _manifest = read_json(DATA_DIR / "manifest.json")
    return _manifest


def gpkg_path() -> Path:
    return Path(manifest()["gpkg"])


def dem_tiles_dir() -> Path:
    return Path(manifest()["dem_tiles"])


def dem_tile_path(gid: str) -> Path:
    return dem_tiles_dir() / f"{gid}_dem_30m.tif"


def table_path(name: str) -> Path | None:
    for p in manifest()["tables"]:
        if Path(p).name == name:
            return Path(p)
    return None


_sources_meta = None


def sources_meta() -> dict:
    global _sources_meta
    if _sources_meta is None:
        _sources_meta = read_json(DATA_DIR / "sources.json")
    return _sources_meta


def _partition_key(key):
    return key[0] if isinstance(key, tuple) else key


# Only a compiled Polars LazyFrame per table is kept resident (a query
# plan against the file on disk, not its data) plus the column-rename
# decision -- both trivially small regardless of the table's row count.
# Actual row data is never held for a whole table: each request scans just
# that one glacier's rows via a predicate-pushdown filter (id_glims == gid),
# so a table with 900k+ rows across 22k glaciers costs the same per request
# whether it's opened once or a thousand times, and nothing about its size
# is ever resident for longer than a single request takes to answer.
_table_plan_cache: dict[str, tuple[pl.LazyFrame, str] | None] = {}
_table_plan_locks: dict[str, threading.Lock] = {}
_table_plan_locks_guard = threading.Lock()


def _lock_for_table(name: str) -> threading.Lock:
    with _table_plan_locks_guard:
        if name not in _table_plan_locks:
            _table_plan_locks[name] = threading.Lock()
        return _table_plan_locks[name]


def _table_plan(name: str) -> tuple[pl.LazyFrame, str] | None:
    """(lazy_frame, id_column) for a table, or None if it doesn't exist --
    built once (reading just the file's schema/footer, not its rows) and
    reused for every subsequent request against that table."""
    if name in _table_plan_cache:
        return _table_plan_cache[name]

    with _lock_for_table(name):
        if name in _table_plan_cache:
            return _table_plan_cache[name]

        path = table_path(name)
        kind = sources_meta().get(name, {}).get("kind")
        if path is None or kind is None or not path.exists():
            _table_plan_cache[name] = None
            return None

        lf = pl.scan_parquet(path) if path.suffix == ".parquet" else pl.scan_csv(path)
        schema_names = lf.collect_schema().names()
        id_col = "glims_id" if "glims_id" in schema_names and "id_glims" not in schema_names else "id_glims"
        if id_col not in schema_names:
            _table_plan_cache[name] = None
            return None

        renames = {}
        if id_col != "id_glims":
            renames[id_col] = "id_glims"
        if "annee" in schema_names and "year" not in schema_names:
            renames["annee"] = "year"
        if renames:
            lf = lf.rename(renames)

        plan = (lf, kind)
        _table_plan_cache[name] = plan
        return plan


def load_table_rows(name: str, gid: str) -> list[dict] | dict | None:
    """This one glacier's rows from a table -- a list of row-dicts for a
    temporal table, a single row-dict for a static one, None if the table
    doesn't exist or has nothing for this id. The filter (id_glims == gid)
    is pushed down into the parquet scan itself, so this reads only the
    row groups that can contain a match, not the whole file."""
    plan = _table_plan(name)
    if plan is None:
        return None
    lf, kind = plan

    filtered = lf.filter(pl.col("id_glims") == gid)
    if kind == "temporal":
        rows = filtered.sort("year").collect().to_dicts()
        return rows if rows else None
    else:
        rows = filtered.collect().to_dicts()
        if not rows:
            return None
        row = rows[0]
        row.pop("id_glims", None)
        return row


def warm_up_in_background() -> None:
    """Kicked off right as the server starts: prepares only what the world
    map itself needs before any glacier is clicked (glacier_evolution's
    index, and every glacier's simplified sgv_ref outline for the map
    layer) -- NOT the per-table glacier data. That stays genuinely lazy
    (see load_table_rows), scanned fresh (with the id filter pushed into
    the parquet read) for every request against a table, never held
    resident for a whole table.

    This used to also pre-load every source table here, in parallel, on the
    theory that paying the disk I/O up front beats paying it on first click.
    In practice that meant materializing every one of the ~13 covariate
    tables (up to ~930k rows each) into a dict-of-Python-dicts, all at once,
    on every server start regardless of whether a session ever looks at
    more than a couple of glaciers -- tens of GB of RAM for data most
    sessions never touch."""

    def run():
        try:
            ensure_glacier_evolution_index()
            ref_outlines()
            _ensure_ref_outlines_grid()
        except Exception as exc:
            print(f"warm-up: failed to index glacier_evolution: {exc}")

    threading.Thread(target=run, daemon=True).start()


_dem_geo_cache: dict[str, tuple[str, list] | None] = {}


def dem_geo(gid: str) -> tuple[str, list] | None:
    """(crs_wkt, transform list) for a glacier's own DEM tile, or None if it
    has no tile. Each DEM_tiles/<glims_id>_dem_30m.tif carries its own local
    projected CRS and a rotated affine transform (minimum-area bounding
    rectangle around the glacier, see the deposit README) -- read straight
    from the GeoTIFF header, cheap enough to do per glacier with no need for
    a separate geo_meta table like the old sgv_annual.gpkg had."""
    if gid in _dem_geo_cache:
        return _dem_geo_cache[gid]

    path = dem_tile_path(gid)
    if not path.exists():
        _dem_geo_cache[gid] = None
        return None

    import rasterio

    with rasterio.open(path) as ds:
        crs_wkt = ds.crs.to_wkt()
        t = ds.transform
        transform = [t.a, t.b, t.c, t.d, t.e, t.f]
    _dem_geo_cache[gid] = (crs_wkt, transform)
    return _dem_geo_cache[gid]


_transformers: dict[str, object] = {}


def transformer_for(crs_wkt: str):
    import pyproj

    if crs_wkt not in _transformers:
        _transformers[crs_wkt] = pyproj.Transformer.from_crs("EPSG:4326", crs_wkt, always_xy=True)
    return _transformers[crs_wkt]


def pixel_coords(transformer, transform: list, lon: float, lat: float) -> tuple[float, float]:
    x, y = transformer.transform(lon, lat)
    a, b, c, d, e, f = transform
    matrix = np.array([[a, b], [d, e]])
    col, row = np.linalg.solve(matrix, [x - c, y - f])
    return float(col), float(row)


def geometry_to_pixel(transformer, transform: list, geometry: dict) -> dict:
    def convert_ring(ring):
        return [list(pixel_coords(transformer, transform, lon, lat)) for lon, lat in ring]

    if geometry["type"] == "Polygon":
        coords = [convert_ring(ring) for ring in geometry["coordinates"]]
    else:  # MultiPolygon
        coords = [[convert_ring(ring) for ring in polygon] for polygon in geometry["coordinates"]]
    return {"type": geometry["type"], "coordinates": coords}


_geometry_cache: dict[str, dict] = {}

# GeoPackage geometry blob header: b"GP" + version byte + flags byte +
# int32 SRS id + an optional envelope, then standard WKB. Bits 1-3 of the
# flags byte say which envelope size follows (0/32/48/48/64 bytes) -- skip
# exactly that many bytes past the fixed 8-byte header to reach the WKB.
_GPKG_ENVELOPE_SIZES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}

_glacier_evolution_indexed = False


def ensure_glacier_evolution_index() -> None:
    """glacier_evolution ships with no attribute index, so a naive WHERE
    glims_id = ? forces a full-table scan -- this layer can be millions of
    rows across every glacier/year/feature combination. Building the index
    costs a few seconds, once ever (persisted in the GeoPackage file
    itself, so it's paid at most once across every future session, not
    once per server start); every lookup after that is instant."""
    global _glacier_evolution_indexed
    if _glacier_evolution_indexed:
        return
    conn = sqlite3.connect(str(gpkg_path()))
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_glacier_evolution_glims_id ON glacier_evolution(glims_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_glacier_evolution_feature_type ON glacier_evolution(feature_type)")
        conn.commit()
    finally:
        conn.close()
    _glacier_evolution_indexed = True


_ref_outlines = None
_ref_outlines_lock = threading.Lock()


def _ref_outlines_cache_path() -> Path:
    """One cache file per gpkg (named after its mtime+size so a replaced
    gpkg invalidates automatically instead of silently serving stale
    outlines) -- sits next to index.json/manifest.json in the same
    viewer/data output directory ingest.py already writes to."""
    gpkg = gpkg_path()
    stat = gpkg.stat()
    return DATA_DIR / f".ref_outlines_cache.{stat.st_mtime_ns}_{stat.st_size}.json"


def ref_outlines() -> list[dict]:
    """Every glacier's sgv_ref outline (id, centroid, simplified geometry),
    loaded once and kept in memory so the map can show every glacier's
    delimitation without a per-glacier round trip. sgv_ref is one row per
    glacier (~22k rows) -- small enough to hold whole, unlike
    glacier_evolution's full multi-year/multi-feature history. Geometry is simplified server
    side (tolerance in degrees, ~10m at these latitudes) since the raw
    footprints are far more detail than a world-map fill needs and 22k full
    -resolution polygons would be a multi-hundred-MB response.

    The shapely WKB-decode-and-simplify pass over all ~22k rows is the
    slow part (a few seconds) -- persisted to a small JSON file on disk
    (keyed to the source gpkg's mtime+size) so it only ever runs once per
    gpkg, not once per server restart, which is what made every fresh
    `python serve.py` feel slow to show footprints on the map."""
    global _ref_outlines
    if _ref_outlines is not None:
        return _ref_outlines
    with _ref_outlines_lock:
        if _ref_outlines is not None:
            return _ref_outlines

        cache_path = _ref_outlines_cache_path()
        if cache_path.exists():
            try:
                _ref_outlines = read_json(cache_path)
                return _ref_outlines
            except Exception:
                pass  # corrupt/partial cache file -- fall through and rebuild

        import shapely.wkb
        from shapely.geometry import mapping

        ensure_glacier_evolution_index()
        conn = sqlite3.connect(str(gpkg_path()))
        rows = conn.execute(
            "SELECT glims_id, centroid_lon, centroid_lat, geom FROM glacier_evolution WHERE feature_type = 'sgv_ref'"
        ).fetchall()
        conn.close()

        outlines = []
        for gid, lon, lat, blob in rows:
            envelope_code = (blob[3] >> 1) & 0x07
            header_len = 8 + _GPKG_ENVELOPE_SIZES.get(envelope_code, 0)
            geom = shapely.wkb.loads(blob[header_len:]).simplify(0.0001, preserve_topology=True)
            outlines.append({
                "id_glims": gid,
                "centroid_lon": lon,
                "centroid_lat": lat,
                "geometry": mapping(geom),
            })
        _ref_outlines = outlines
        try:
            for old in DATA_DIR.glob(".ref_outlines_cache.*.json"):
                old.unlink(missing_ok=True)
            cache_path.write_bytes(orjson.dumps(outlines))
        except OSError:
            pass  # best-effort -- still works in-memory for this session even if the write fails
        return _ref_outlines


_ref_outlines_grid: dict[tuple[int, int], list[int]] | None = None
_ref_outlines_lon: np.ndarray | None = None
_ref_outlines_lat: np.ndarray | None = None
GRID_CELL_DEG = 1.0  # ~110km at the equator -- coarse enough that most map viewports span only a handful of cells


def _ensure_ref_outlines_grid() -> None:
    """Buckets every glacier's centroid into 1x1 degree grid cells so a
    bbox query only has to look at the handful of cells the viewport
    actually overlaps, instead of scanning every one of the ~22k glaciers
    on every pan/zoom. Built once, lazily, right after ref_outlines()
    itself is available."""
    global _ref_outlines_grid, _ref_outlines_lon, _ref_outlines_lat
    if _ref_outlines_grid is not None:
        return

    outlines = ref_outlines()
    lons = np.full(len(outlines), np.nan, dtype=np.float64)
    lats = np.full(len(outlines), np.nan, dtype=np.float64)
    grid: dict[tuple[int, int], list[int]] = {}
    for i, o in enumerate(outlines):
        lon, lat = o["centroid_lon"], o["centroid_lat"]
        if lon is None or lat is None:
            continue
        lons[i] = lon
        lats[i] = lat
        cell = (int(np.floor(lon / GRID_CELL_DEG)), int(np.floor(lat / GRID_CELL_DEG)))
        grid.setdefault(cell, []).append(i)

    _ref_outlines_lon = lons
    _ref_outlines_lat = lats
    _ref_outlines_grid = grid


def outlines_in_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> list[dict]:
    _ensure_ref_outlines_grid()
    outlines = ref_outlines()

    cell_min_x = int(np.floor(min_lon / GRID_CELL_DEG))
    cell_max_x = int(np.floor(max_lon / GRID_CELL_DEG))
    cell_min_y = int(np.floor(min_lat / GRID_CELL_DEG))
    cell_max_y = int(np.floor(max_lat / GRID_CELL_DEG))

    candidate_idx: list[int] = []
    for cx in range(cell_min_x, cell_max_x + 1):
        for cy in range(cell_min_y, cell_max_y + 1):
            candidate_idx.extend(_ref_outlines_grid.get((cx, cy), ()))
    if not candidate_idx:
        return []

    idx = np.array(candidate_idx, dtype=np.int64)
    lon = _ref_outlines_lon[idx]
    lat = _ref_outlines_lat[idx]
    inside = (lon >= min_lon) & (lon <= max_lon) & (lat >= min_lat) & (lat <= max_lat)
    return [outlines[i] for i in idx[inside]]


def _decode_gpkg_geometry(blob: bytes) -> dict:
    import shapely.wkb
    from shapely.geometry import mapping

    envelope_code = (blob[3] >> 1) & 0x07
    header_len = 8 + _GPKG_ENVELOPE_SIZES.get(envelope_code, 0)
    return mapping(shapely.wkb.loads(blob[header_len:]))


_GEOM_SERIES_COLUMNS = (
    "year", "feature_type", "area_m2", "centroid_lon", "centroid_lat",
    "elevation_m", "displacement_from_ref_m",
)


def load_geometry(gid: str) -> dict:
    """Outline + year series for one glacier, read straight from the
    GeoPackage's glacier_evolution SQLite table scoped to just this id
    (plain sqlite3, not DuckDB's ST_Read -- ST_Read doesn't push the WHERE
    down to the SQLite layer, it materializes/converts the whole table
    first and filters after, which defeats the point of a per-glacier
    lookup). Also keeps each record's raw geom blob (stripped out of
    geom_series before it's sent to the client) so _compute_raster can
    rasterize every year's snow/ice/other/cloud polygon without a second
    round trip to the GeoPackage."""
    if gid in _geometry_cache:
        return _geometry_cache[gid]

    ensure_glacier_evolution_index()

    conn = sqlite3.connect(str(gpkg_path()))
    rows = conn.execute(
        f"SELECT {', '.join(_GEOM_SERIES_COLUMNS)}, geom FROM glacier_evolution WHERE glims_id = ?",
        (gid,),
    ).fetchall()
    conn.close()

    result = {"outline": None, "geom_series": [], "records": []}
    if not rows:
        _geometry_cache[gid] = result
        return result

    records = [dict(zip((*_GEOM_SERIES_COLUMNS, "geom"), row)) for row in rows]

    ref_rows = [r for r in records if r["feature_type"] == "sgv_ref"]
    if ref_rows:
        geometry = _decode_gpkg_geometry(ref_rows[0]["geom"])
        is_fallback = False
    else:
        # No dedicated sgv_ref polygon for this glacier -- fall back to the
        # most recent year's sgv, then ice, then snow footprint so the
        # reference-footprint chart always has something to draw.
        geometry = None
        is_fallback = True
        for candidate_type in ("sgv", "ice", "snow"):
            candidates = sorted(
                (r for r in records if r["feature_type"] == candidate_type), key=lambda r: r["year"]
            )
            if candidates:
                geometry = _decode_gpkg_geometry(candidates[-1]["geom"])
                break

    series_rows = [
        {k: v for k, v in r.items() if k != "geom"} for r in records if r["feature_type"] != "sgv_ref"
    ]

    geo = dem_geo(gid)
    transformer = None
    transform = None
    if geo is not None:
        crs_wkt, transform = geo
        transformer = transformer_for(crs_wkt)
        for row in series_rows:
            col, px_row = pixel_coords(transformer, transform, row["centroid_lon"], row["centroid_lat"])
            row["centroid_col"] = col
            row["centroid_row"] = px_row

    if geometry is not None:
        outline_entry = {"is_fallback": is_fallback, "geometry": geometry}
        if transformer is not None:
            outline_entry["pixel_geometry"] = geometry_to_pixel(transformer, transform, geometry)
        result["outline"] = outline_entry

    result["geom_series"] = series_rows
    result["records"] = records
    _geometry_cache[gid] = result
    return result


def footprint_outside_mask(pixel_geometry: dict, height: int, width: int):
    """Boolean (height, width) array, True outside the reference footprint --
    used to NaN out DEM pixels beyond the glacier's sgv_ref polygon so the
    3D/heatmap views show only the glacier, not its whole raster bounding
    box. pixel_geometry's coordinates are already in (col, row) pixel space
    (see geometry_to_pixel), so an identity affine transform maps them
    straight onto the DEM/sgv_stack grid with no reprojection needed."""
    import rasterio.features
    from affine import Affine
    from shapely.geometry import shape

    geom = shape(pixel_geometry)
    if geom.is_empty:
        return None
    return rasterio.features.geometry_mask(
        [geom], out_shape=(height, width), transform=Affine.identity(), invert=False
    )


_raster_cache: dict[str, dict | None] = {}
_raster_locks: dict[str, threading.Lock] = {}
_raster_locks_guard = threading.Lock()


def _lock_for_raster(gid: str) -> threading.Lock:
    with _raster_locks_guard:
        if gid not in _raster_locks:
            _raster_locks[gid] = threading.Lock()
        return _raster_locks[gid]


def _raster_disk_path(gid: str) -> Path:
    # id_glims values are plain glacier codes (no path separators), so the
    # id itself is a safe filename component.
    return RASTER_CACHE_DIR / f"{gid}.npz"


def _load_raster_from_disk(gid: str) -> dict | None:
    path = _raster_disk_path(gid)
    if not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as npz:
            return {
                "n_years": int(npz["n_years"]),
                "height": int(npz["height"]),
                "width": int(npz["width"]),
                "years": npz["years"].tolist(),
                "sgv_stack": npz["sgv_stack"],
                "change_heatmap": npz["change_heatmap"],
                "cloud_years": npz["cloud_years"],
                "footprint_masked": bool(npz["footprint_masked"]),
                "dem": npz["dem"] if "dem" in npz else None,
                "dem_clipped": npz["dem_clipped"] if "dem_clipped" in npz else None,
            }
    except Exception:
        return None  # corrupt/partial cache file -- fall through and recompute


def _save_raster_to_disk(gid: str, result: dict) -> None:
    RASTER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fields = {
        "n_years": result["n_years"],
        "height": result["height"],
        "width": result["width"],
        "years": np.array(result["years"], dtype=np.int16),
        "sgv_stack": result["sgv_stack"],
        "change_heatmap": result["change_heatmap"],
        "cloud_years": result["cloud_years"],
        "footprint_masked": result["footprint_masked"],
    }
    if result["dem"] is not None:
        fields["dem"] = result["dem"]
    if result["dem_clipped"] is not None:
        fields["dem_clipped"] = result["dem_clipped"]
    try:
        # Written to a temp file then renamed -- an interrupted write (server
        # killed mid-save) must never leave a partial .npz that a later
        # request would try to load and fail on.
        tmp_path = _raster_disk_path(gid).with_suffix(".npz.tmp")
        np.savez_compressed(tmp_path, **fields)
        tmp_path.replace(_raster_disk_path(gid))
    except OSError:
        pass  # best-effort -- still works in-memory for this session even if the write fails


def load_raster(gid: str):
    """DEM + classification stack + change heatmap for one glacier, read
    from that glacier's DEM_tiles GeoTIFF and rasterized from its
    glacier_evolution polygons -- only for glaciers actually clicked. Persisted to
    disk (viewer/data/.raster_cache_v2/<id>.npz) after the first computation,
    since the change-heatmap pass and DEM decode are the most expensive
    per-glacier work here -- without this, every server restart re-pays
    that cost for every glacier revisited, even though nothing about the
    source data changed."""
    if gid in _raster_cache:
        return _raster_cache[gid]

    with _lock_for_raster(gid):
        if gid in _raster_cache:  # finished by another thread while we waited
            return _raster_cache[gid]

        from_disk = _load_raster_from_disk(gid)
        if from_disk is not None:
            _raster_cache[gid] = from_disk
            return from_disk

        result = _compute_raster(gid)
        _raster_cache[gid] = result
        if result is not None:
            _save_raster_to_disk(gid, result)
        return result


_CLASS_FOR_FEATURE_TYPE = {"other": 0, "snow": 1, "ice": 2, "cloud": CLOUD_EXCLUDED}


def _rasterize_year_classes(records: list[dict], years: list[int], height: int, width: int) -> np.ndarray:
    """Rebuilds the old sgv_stack (n_years, height, width) uint8 array by
    burning each year's snow/ice/other/cloud polygon (already reprojected
    to pixel space by load_geometry's geometry_to_pixel, keyed on
    (year, feature_type) in `records`) onto the DEM's own grid, painted in
    priority order other < snow < ice < cloud so overlaps at class
    boundaries resolve the same way the source map_etat classification
    would. Pixels no polygon covers for a given year (there is genuinely no
    footprint/classification there) default to Other (0), matching how the
    old rasterized stack treated background."""
    import rasterio.features
    from affine import Affine
    from shapely.geometry import shape

    year_index = {y: t for t, y in enumerate(years)}
    stack = np.zeros((len(years), height, width), dtype=np.uint8)

    for record in records:
        feature_type = record["feature_type"]
        class_value = _CLASS_FOR_FEATURE_TYPE.get(feature_type)
        if class_value is None:  # sgv_ref / sgv are footprints, not a pixel class of their own
            continue
        t = year_index.get(record["year"])
        if t is None:
            continue
        pixel_geometry = record.get("pixel_geometry")
        if pixel_geometry is None:
            continue
        geom = shape(pixel_geometry)
        if geom.is_empty:
            continue
        painted = rasterio.features.rasterize(
            [(geom, class_value)],
            out_shape=(height, width),
            transform=Affine.identity(),
            fill=0,
            default_value=class_value,
        )
        mask = painted == class_value
        # Priority other(0) < snow(1) < ice(2) < cloud(3): only raise a
        # pixel's class, never lower it, so a later-painted lower-priority
        # type in `records` can't overwrite an already-classified pixel.
        stack[t] = np.where(mask & (class_value > stack[t]), class_value, stack[t])

    return stack


def _compute_raster(gid: str):
    geometry_data = load_geometry(gid)
    records = geometry_data["records"]
    outline = geometry_data["outline"]

    dem_path = dem_tile_path(gid)
    if not records or not dem_path.exists():
        return None

    import rasterio

    with rasterio.open(dem_path) as ds:
        dem = ds.read(1).astype(np.float32)
        nodata = ds.nodata
        height, width = ds.height, ds.width
    if nodata is not None:
        dem[dem == nodata] = np.nan

    geo = dem_geo(gid)
    transformer = transformer_for(geo[0]) if geo is not None else None
    transform = geo[1] if geo is not None else None

    years = sorted({r["year"] for r in records if r["feature_type"] in _CLASS_FOR_FEATURE_TYPE})
    n_years = len(years)

    if transformer is not None:
        for record in records:
            if record["feature_type"] not in _CLASS_FOR_FEATURE_TYPE or record.get("geom") is None:
                continue
            geometry = _decode_gpkg_geometry(record["geom"])
            record["pixel_geometry"] = geometry_to_pixel(transformer, transform, geometry)

    sgv = _rasterize_year_classes(records, years, height, width) if n_years else np.zeros((0, height, width), dtype=np.uint8)

    footprint_masked = False
    if outline is not None and "pixel_geometry" in outline:
        outside = footprint_outside_mask(outline["pixel_geometry"], height, width)
        if outside is not None:
            # Distinct from CLOUD_EXCLUDED: this pixel simply isn't part of
            # the glacier footprint, it was never classified as cloud by the
            # source data. Conflating the two here used to make "cloud" in
            # the 2D/3D charts read as mostly background-outside-the-glacier
            # rather than the gpkg's actual per-year cloud polygons.
            sgv[:, outside] = OUTSIDE_FOOTPRINT
            footprint_masked = True
    # Without a pixel-space footprint (no DEM transform for this glacier),
    # there's no way to tell glacier pixels from raw background noise in
    # the raster's bounding box -- rather than silently treat every pixel
    # as valid (background classification noise outside the real glacier
    # can flip class year to year just as much as, or more than, real
    # change inside it, which reads as "the heatmap is inverted"), the
    # client is told via footprint_masked so it can warn instead of
    # showing a heatmap that looks meaningful but isn't.

    # Classes: 0 Other, 1 Snow, 2 Ice, 3 Cloud-excluded, 4 Outside footprint.
    # Any change of state between Other/Snow/Ice counts as a surface change --
    # Cloud-excluded and Outside-footprint years are both skipped (there's
    # genuinely no observation that year to compare). A pixel that's Snow,
    # then cloud-excluded, then Ice two years later is still a real change
    # once you look past the missing middle year -- each pixel compares its
    # most recent valid observation against the next one, carrying forward
    # across any number of skipped years in between, rather than only ever
    # comparing directly-adjacent years.
    change = np.zeros((height, width), dtype=np.int32)
    last_valid = np.full((height, width), -1, dtype=np.int16)  # last seen valid class, -1 = none yet
    for t in range(n_years):
        cur = sgv[t]
        is_valid = (cur != CLOUD_EXCLUDED) & (cur != OUTSIDE_FOOTPRINT)
        has_prev = last_valid != -1
        compare = is_valid & has_prev
        change += (compare & (cur != last_valid)).astype(np.int32)
        last_valid = np.where(is_valid, cur, last_valid)

    # How many of the n_years were cloud-excluded at each pixel -- shown
    # alongside the change count so a pixel with zero recorded changes can
    # be told apart from one that simply never had two comparable
    # (non-cloud) years to compare in the first place. Outside-footprint
    # pixels are never real cloud, so they're not counted here.
    cloud_years = (sgv == CLOUD_EXCLUDED).sum(axis=0).astype(np.int32) if n_years else np.zeros((height, width), dtype=np.int32)

    # Two variants: the outline/heatmap/altitude-evolution charts show only
    # the glacier, so their DEM is clipped to the sgv_ref footprint; the
    # centroid charts show the surrounding terrain for context, so they get
    # the untouched full raster plus the footprint drawn as an outline on
    # top (see outline_pixel.geojson) instead of a clip.
    dem_clipped = dem
    if outline is not None and "pixel_geometry" in outline and dem.shape == (height, width):
        outside = footprint_outside_mask(outline["pixel_geometry"], height, width)
        if outside is not None:
            dem_clipped = dem.copy()
            dem_clipped[outside] = np.nan

    result = {
        "n_years": n_years,
        "height": height,
        "width": width,
        "years": years,
        "sgv_stack": sgv,
        "change_heatmap": change,
        "cloud_years": cloud_years,
        "footprint_masked": footprint_masked,
        "dem": dem,
        "dem_clipped": dem_clipped,
    }
    return result


# --- Altitude evolution (connected components + TSL proxy) -----------------
#
# Ported from the client-side flood-fill in altitude_evolution.js: same
# algorithm (8-connectivity components per class per year, TSL as the
# median elevation of the snow/ice contact frontier), but computed here with
# scipy.ndimage.label -- a compiled, vectorized connected-components pass
# instead of a hand-rolled JS stack-based flood fill -- and persisted to
# disk alongside the raster cache so it's paid once per glacier, not on
# every chart render in every browser tab that opens it.

CLASS_SNOW = 1
CLASS_ICE = 2
CLASS_CLOUD = 3

# 8-connectivity structuring element -- matches scipy.ndimage.generate_
# binary_structure(2, 2), which is what the reference pipeline
# (accum_ablation_engine.py) and the original JS flood fill both use.
_STRUCTURE_8CONN = np.ones((3, 3), dtype=bool)

_altitude_evolution_cache: dict[str, dict] = {}
_altitude_evolution_locks: dict[str, threading.Lock] = {}
_altitude_evolution_locks_guard = threading.Lock()


def _lock_for_altitude_evolution(gid: str) -> threading.Lock:
    with _altitude_evolution_locks_guard:
        if gid not in _altitude_evolution_locks:
            _altitude_evolution_locks[gid] = threading.Lock()
        return _altitude_evolution_locks[gid]


def _altitude_evolution_disk_path(gid: str) -> Path:
    return RASTER_CACHE_DIR / f"{gid}.altitude_evolution.json"


def _quantile(sorted_values: np.ndarray, q: float) -> float | None:
    """numpy.quantile's default (linear interpolation between closest
    ranks) -- matches the reference pipeline's _safe_quantile exactly."""
    if sorted_values.size == 0:
        return None
    return float(np.quantile(sorted_values, q, method="linear"))


def _group_points_for_class(dem: np.ndarray, class_plane: np.ndarray, year: int, target_class: int) -> list[dict]:
    mask = class_plane == target_class
    if not mask.any():
        return []
    labeled, n_groups = ndimage_label(mask, structure=_STRUCTURE_8CONN)
    points = []
    # ndimage.sum/mean/etc. over label ids in one vectorized call each,
    # instead of one Python-level pass per connected component -- the
    # per-group loop below only ever runs len(unique labels) times to
    # assemble the output dicts, not once per pixel.
    label_ids = np.arange(1, n_groups + 1)
    pixel_counts = ndimage_sum(mask, labeled, label_ids)
    valid_dem = ~np.isnan(dem)
    dem_filled = np.where(valid_dem, dem, 0.0)
    valid_mask = mask & valid_dem
    valid_counts = ndimage_sum(valid_mask, labeled, label_ids)
    sums = ndimage_sum(dem_filled * valid_mask, labeled, label_ids)
    mins = ndimage_minimum(np.where(valid_mask, dem, np.inf), labeled, label_ids)
    maxs = ndimage_maximum(np.where(valid_mask, dem, -np.inf), labeled, label_ids)

    for i, label_id in enumerate(label_ids):
        count = valid_counts[i]
        if count <= 0:
            continue
        points.append({
            "year": year,
            "min": float(mins[i]),
            "max": float(maxs[i]),
            "mean": float(sums[i] / count),
            "pixelCount": int(pixel_counts[i]),
        })
    return points


def _dilate_once(mask: np.ndarray) -> np.ndarray:
    return ndimage_binary_dilation(mask, structure=_STRUCTURE_8CONN)


def _tsl_for_year(dem: np.ndarray, class_plane: np.ndarray) -> float | None:
    mask_snow = class_plane == CLASS_SNOW
    mask_ice = class_plane == CLASS_ICE
    has_snow = mask_snow.any()
    has_ice = mask_ice.any()
    valid = ~np.isnan(dem)

    if has_snow and has_ice:
        ice_dilated = _dilate_once(mask_ice)
        frontier = dem[mask_snow & ice_dilated & valid]
        if frontier.size:
            return _quantile(np.sort(frontier), 0.5)
        return None
    if has_snow:
        z_snow = np.sort(dem[mask_snow & valid])
        if z_snow.size == 0:
            return None
        q20 = _quantile(z_snow, 0.2)
        low = z_snow[z_snow <= q20] if q20 is not None else z_snow
        if low.size == 0:
            low = z_snow
        return _quantile(np.sort(low), 0.5)
    if has_ice:
        z_ice = dem[mask_ice & valid]
        if z_ice.size == 0:
            return None
        return float(np.max(z_ice))
    return None


def _compute_altitude_evolution(raster: dict) -> dict:
    dem = raster["dem"]
    sgv = raster["sgv_stack"]
    years = raster["years"]
    n_years = raster["n_years"]
    height = raster["height"]
    width = raster["width"]

    accumulation = []
    ablation = []
    tsl = []

    for t in range(n_years):
        plane = sgv[t]
        accumulation.extend(_group_points_for_class(dem, plane, years[t], CLASS_SNOW))
        ablation.extend(_group_points_for_class(dem, plane, years[t], CLASS_ICE))
        tsl_value = _tsl_for_year(dem, plane)
        if tsl_value is not None:
            tsl.append([years[t], tsl_value])

    valid_dem = dem[~np.isnan(dem)]
    sgv_ref_max_elevation = float(np.max(valid_dem)) if valid_dem.size else None

    return {
        "accumulation": accumulation,
        "ablation": ablation,
        "tsl": tsl,
        "sgv_ref_max_elevation": sgv_ref_max_elevation,
    }


def load_altitude_evolution(gid: str, raster: dict) -> dict:
    if gid in _altitude_evolution_cache:
        return _altitude_evolution_cache[gid]

    with _lock_for_altitude_evolution(gid):
        if gid in _altitude_evolution_cache:
            return _altitude_evolution_cache[gid]

        disk_path = _altitude_evolution_disk_path(gid)
        if disk_path.exists():
            try:
                result = read_json(disk_path)
                _altitude_evolution_cache[gid] = result
                return result
            except Exception:
                pass  # corrupt/partial cache file -- fall through and recompute

        result = _compute_altitude_evolution(raster)
        _altitude_evolution_cache[gid] = result
        try:
            RASTER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp_path = disk_path.with_suffix(".json.tmp")
            tmp_path.write_bytes(orjson.dumps(result, option=orjson.OPT_SERIALIZE_NUMPY))
            tmp_path.replace(disk_path)
        except OSError:
            pass  # best-effort -- still works in-memory for this session even if the write fails
        return result


# --- Map tile cache (offline support) ---------------------------------------
#
# Proxies OpenStreetMap tiles through this server instead of the client
# fetching tile.openstreetmap.org directly, caching every tile fetched to
# disk under data/.tile_cache/. Once an area has been panned/zoomed into
# with a connection, every tile it needed is on disk and the map keeps
# working with no network on a later run -- no separate bulk-download step,
# the cache just fills in as areas get visited.

TILE_CACHE_DIR = DATA_DIR / ".tile_cache"
TILE_PATH_RE = re.compile(r"^/tiles/(\d+)/(\d+)/(\d+)\.png$")
OSM_TILE_SERVERS = ("a", "b", "c")
_tile_locks: dict[str, threading.Lock] = {}
_tile_locks_guard = threading.Lock()


def _lock_for_tile(key: str) -> threading.Lock:
    with _tile_locks_guard:
        if key not in _tile_locks:
            _tile_locks[key] = threading.Lock()
        return _tile_locks[key]


def _tile_disk_path(z: str, x: str, y: str) -> Path:
    return TILE_CACHE_DIR / z / x / f"{y}.png"


def load_tile(z: str, x: str, y: str) -> bytes | None:
    """PNG bytes for one tile, disk-cached, or None if it can't be fetched
    (no network and not cached yet, or upstream 404 for that z/x/y)."""
    path = _tile_disk_path(z, x, y)
    if path.exists():
        try:
            return path.read_bytes()
        except OSError:
            pass  # fall through and refetch

    key = f"{z}/{x}/{y}"
    with _lock_for_tile(key):
        if path.exists():
            try:
                return path.read_bytes()
            except OSError:
                pass

        import urllib.request

        server = OSM_TILE_SERVERS[(int(x) + int(y)) % len(OSM_TILE_SERVERS)]
        url = f"https://{server}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "GlacierScope/1.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                body = resp.read()
        except Exception:
            return None  # offline, or this tile doesn't exist upstream -- not fatal

        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = path.with_suffix(".png.tmp")
            tmp_path.write_bytes(body)
            tmp_path.replace(path)
        except OSError:
            pass  # best-effort -- tile is still served from the in-memory `body` below
        return body


# --- HTTP handler ------------------------------------------------------------


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Map tiles are immutable once cached (same z/x/y always resolves to
        # the same disk-cached PNG) and re-requested constantly while panning
        # -- letting the browser cache them itself avoids re-asking this
        # server (and, on a first-ever visit, OSM) for a tile it already
        # has. Everything else stays no-store: per-glacier JSON/binary data
        # can change across ingestion re-runs and must never be served stale.
        if not getattr(self, "_serving_tile", False):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # per-glacier requests are frequent; keep the console quiet

    def do_GET(self):
        split = urlsplit(self.path)
        if split.path == "/data/outlines_bbox.json":
            try:
                self._handle_outlines_bbox(parse_qs(split.query))
            except Exception as exc:
                self._send_error(exc)
            return
        tile_match = TILE_PATH_RE.match(split.path)
        if tile_match:
            try:
                self._handle_tile(*tile_match.groups())
            except Exception as exc:
                self._send_error(exc)
            return
        match = GLACIER_PATH_RE.match(split.path)
        if match:
            gid = match.group(1)
            if gid in (".", ".."):
                self._send_not_found()
                return
            try:
                self._handle_glacier(gid, match.group(2))
            except Exception as exc:
                self._send_error(exc)
            return
        super().do_GET()

    def _handle_tile(self, z: str, x: str, y: str) -> None:
        body = load_tile(z, x, y)
        if body is None:
            self._send_not_found()
            return
        self._serving_tile = True
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "public, max-age=2592000, immutable")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_outlines_bbox(self, query: dict) -> None:
        try:
            min_lon = float(query["min_lon"][0])
            min_lat = float(query["min_lat"][0])
            max_lon = float(query["max_lon"][0])
            max_lat = float(query["max_lat"][0])
        except (KeyError, ValueError, IndexError):
            self._send_error(ValueError("outlines_bbox.json requires min_lon, min_lat, max_lon, max_lat"))
            return
        outlines = outlines_in_bbox(min_lon, min_lat, max_lon, max_lat)
        self._send_json({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"id_glims": o["id_glims"]},
                    "geometry": o["geometry"],
                }
                for o in outlines
            ],
        })

    def _accepts_gzip(self) -> bool:
        return "gzip" in self.headers.get("Accept-Encoding", "")

    # sgv_stack.bin/dem*.bin are raw arrays with a lot of repeated bytes
    # (sgv_stack: only 4 distinct class values per pixel; DEM: smoothly
    # varying floats) -- both compress well, and gzip is the one encoding
    # every browser already sends in Accept-Encoding, so compressing here
    # cuts real transfer time on these particular payloads without any
    # client-side change needed. JSON payloads are almost all coordinates/
    # floats already handled by orjson and are typically far smaller than
    # the raw binaries, so left uncompressed to avoid paying the
    # compression cost where it barely matters.
    def _send_json(self, payload) -> None:
        body = orjson.dumps(payload, option=orjson.OPT_SERIALIZE_NUMPY)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        if self._accepts_gzip():
            body = gzip.compress(body, compresslevel=6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_not_found(self) -> None:
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_error(self, exc: Exception) -> None:
        # A client that disconnects mid-response (closed tab, cancelled tile
        # fetch while panning) makes the ORIGINAL write raise a connection
        # error, which do_GET routes here to report as a 500 -- but the
        # socket is already dead, so trying to write anything raises again,
        # this time uncaught, crashing the request-handling thread with a
        # confusing second traceback. Nothing to report to a client that's
        # already gone, so just let it drop.
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        try:
            body = str(exc).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def _handle_glacier(self, gid: str, resource: str) -> None:
        if resource == "meta.json":
            payload = {}
            for name, info in sources_meta().items():
                if info["kind"] != "static":
                    continue
                record = load_table_rows(name, gid)
                if record is not None:
                    payload[name] = record
            self._send_json(payload)

        elif resource == "year_series.json":
            payload = {}
            for name, info in sources_meta().items():
                if info["kind"] != "temporal":
                    continue
                rows = load_table_rows(name, gid)
                if rows is not None:
                    payload[name] = rows
            self._send_json(payload)

        elif resource == "geom_series.json":
            self._send_json(load_geometry(gid)["geom_series"])

        elif resource == "outline.geojson":
            entry = load_geometry(gid)["outline"]
            if entry is None:
                self._send_not_found()
                return
            self._send_json({
                "type": "Feature",
                "properties": {"is_fallback": entry["is_fallback"]},
                "geometry": entry["geometry"],
            })

        elif resource == "outline_pixel.geojson":
            entry = load_geometry(gid)["outline"]
            if entry is None or "pixel_geometry" not in entry:
                self._send_not_found()
                return
            self._send_json({
                "type": "Feature",
                "properties": {"is_fallback": entry["is_fallback"]},
                "geometry": entry["pixel_geometry"],
            })

        elif resource == "dem_meta.json":
            # Clipped to the sgv_ref footprint -- for the charts that show
            # only the glacier (outline, heatmap, altitude evolution).
            raster = load_raster(gid)
            if raster is None or raster["dem_clipped"] is None:
                self._send_not_found()
                return
            height, width = raster["dem_clipped"].shape
            self._send_json({"height": int(height), "width": int(width)})

        elif resource == "dem.bin":
            raster = load_raster(gid)
            if raster is None or raster["dem_clipped"] is None:
                self._send_not_found()
                return
            self._send_binary(raster["dem_clipped"].tobytes())

        elif resource == "dem_full_meta.json":
            # Full, unclipped raster -- for the centroid charts, which show
            # surrounding terrain for context with just the footprint
            # outline drawn on top, not cut away.
            raster = load_raster(gid)
            if raster is None or raster["dem"] is None:
                self._send_not_found()
                return
            height, width = raster["dem"].shape
            self._send_json({"height": int(height), "width": int(width)})

        elif resource == "dem_full.bin":
            raster = load_raster(gid)
            if raster is None or raster["dem"] is None:
                self._send_not_found()
                return
            self._send_binary(raster["dem"].tobytes())

        elif resource == "sgv_stack_meta.json":
            raster = load_raster(gid)
            if raster is None:
                self._send_not_found()
                return
            self._send_json({
                "n_years": raster["n_years"],
                "height": raster["height"],
                "width": raster["width"],
                "years": raster["years"],
            })

        elif resource == "sgv_stack.bin":
            raster = load_raster(gid)
            if raster is None:
                self._send_not_found()
                return
            self._send_binary(raster["sgv_stack"].tobytes())

        elif resource == "altitude_evolution.json":
            raster = load_raster(gid)
            if raster is None or raster["dem"] is None or raster["dem"].shape != (raster["height"], raster["width"]):
                self._send_not_found()
                return
            self._send_json(load_altitude_evolution(gid, raster))

        elif resource == "change_heatmap.json":
            raster = load_raster(gid)
            if raster is None:
                self._send_not_found()
                return
            self._send_json({
                "height": raster["height"],
                "width": raster["width"],
                "n_years": raster["n_years"],
                "values": raster["change_heatmap"].flatten(),
                "cloud_years": raster["cloud_years"].flatten(),
                "footprint_masked": raster["footprint_masked"],
            })

        else:
            self._send_not_found()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Bound to loopback only -- this is a local single-user viewer, not a
    # service meant to be reachable from other machines on the network.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    warm_up_in_background()
    print(f"Serving on http://localhost:{port}, no caching.")
    server.serve_forever()


if __name__ == "__main__":
    main()
