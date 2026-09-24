"""
ingest.py
----------
Builds the minimal viewer/data/ files needed to show the world map, from
files the user picks directly -- one GeoPackage (glacier_evolution_full.gpkg,
the combined vector file from the Glacier_Evolution Zenodo deposit), the
DEM_tiles/ folder that ships alongside it, and any number of parquet/csv
tables. No fixed folder layout is assumed for the tables, so it does not
matter whether they came from the Nature_Deposit or RSE_Deposit Zenodo
export, or were renamed, or live in different folders.

The GeoPackage carries one `glacier_evolution` layer with every footprint
type (sgv_ref, sgv, snow, ice, other, cloud) stacked, keyed by
(glims_id, year, feature_type) -- see DEM_tiles/README.md in the deposit.
There is no rasterized per-pixel classification stack or embedded DEM blob
in it any more (the old sgv_annual.gpkg had both, as custom sqlite tables);
serve.py rebuilds an equivalent pixel stack lazily by rasterizing this
layer's polygons onto each glacier's own DEM_tiles/<glims_id>_dem_30m.tif
grid, the moment that glacier is actually clicked.

This used to also extract every glacier's geometry, DEM, and
classification stack up front -- but with 20k+ glaciers on the map and a
user only ever clicking through a handful of them, that was almost all
wasted work (and, written out as one file per glacier, the dominant cost
in practice: Windows antivirus scanning every single file creation). Both
problems disappear the same way: don't do the per-glacier work here at
all. serve.py does it lazily, straight from the source files, the moment a
glacier is actually clicked, and keeps the result in memory for the rest
of the session.

Two source-data quirks handled here, once, so nothing downstream has to
deal with them:
  - the glacier id column is spelled `id_glims` almost everywhere but
    `glims_id` in the GeoPackage
  - the year column is spelled `year` almost everywhere but `annee` in a
    handful of files

Output under --out:
  index.json      id_glims, lon, lat -- world map + search
  sources.json    which files were ingested, static vs per-year, column dtypes
  manifest.json   {gpkg, dem_tiles, tables: [paths]} -- so serve.py knows
                   where to read per-glacier data from on demand

Usage:
    python ingest.py                                  # opens a file picker
    python ingest.py --gpkg glacier_evolution_full.gpkg --dem-tiles DEM_tiles --tables glacier_ref.parquet 01_fsn_annual.csv ...
"""

from __future__ import annotations

import argparse
from pathlib import Path

import orjson
import polars as pl


def write_json(path: Path, obj) -> None:
    """orjson instead of the stdlib json module -- it's implemented in Rust
    and serializes the whole dataset in one shot faster than stdlib json."""
    path.write_bytes(orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY, default=str))


def read_json(path: Path):
    return orjson.loads(path.read_bytes())


LAST_SELECTION_PATH = Path(__file__).resolve().parent / ".last_selection.json"


def load_last_selection() -> dict:
    if not LAST_SELECTION_PATH.exists():
        return {"gpkg": "", "dem_tiles": "", "tables": []}
    try:
        selection = read_json(LAST_SELECTION_PATH)
    except Exception:
        return {"gpkg": "", "dem_tiles": "", "tables": []}
    selection.setdefault("dem_tiles", "")
    return selection


def save_last_selection(gpkg_path: Path, dem_tiles_dir: Path, table_paths: list[Path]) -> None:
    write_json(LAST_SELECTION_PATH, {
        "gpkg": str(gpkg_path),
        "dem_tiles": str(dem_tiles_dir),
        "tables": [str(p) for p in table_paths],
    })


def pick_files_gui() -> tuple[Path, Path, list[Path], bool]:
    """Tk dialog: pick one .gpkg (glacier_evolution_full.gpkg), one DEM_tiles
    folder, and any number of .parquet/.csv tables. Remembers the last
    selection and pre-fills it on open.

    Returns (gpkg_path, dem_tiles_dir, table_paths, needs_rebuild).
    needs_rebuild is False only when the selection is exactly what it was
    last time and the "Rebuild" box is left unchecked -- in that case the
    caller can skip straight to launching the viewer against the existing
    cache instead of re-running the whole ingestion pipeline for nothing."""
    import tkinter as tk
    from tkinter import filedialog, messagebox

    remembered = load_last_selection()

    root = tk.Tk()
    root.title("GlacierScope")
    root.geometry("640x560")

    gpkg_path = tk.StringVar(value=remembered.get("gpkg", ""))
    dem_tiles_dir = tk.StringVar(value=remembered.get("dem_tiles", ""))
    table_paths: list[str] = [p for p in remembered.get("tables", []) if Path(p).exists()]

    tk.Label(root, text="GIS file (glacier_evolution_full.gpkg)", anchor="w").pack(fill="x", padx=10, pady=(10, 0))
    gpkg_row = tk.Frame(root)
    gpkg_row.pack(fill="x", padx=10)
    tk.Entry(gpkg_row, textvariable=gpkg_path, state="readonly").pack(side="left", fill="x", expand=True)

    def choose_gpkg():
        path = filedialog.askopenfilename(
            title="Select glacier_evolution_full.gpkg", filetypes=[("GeoPackage", "*.gpkg")]
        )
        if path:
            gpkg_path.set(path)

    tk.Button(gpkg_row, text="Browse...", command=choose_gpkg).pack(side="left", padx=(6, 0))

    tk.Label(root, text="DEM folder (DEM_tiles)", anchor="w").pack(fill="x", padx=10, pady=(10, 0))
    dem_row = tk.Frame(root)
    dem_row.pack(fill="x", padx=10)
    tk.Entry(dem_row, textvariable=dem_tiles_dir, state="readonly").pack(side="left", fill="x", expand=True)

    def choose_dem_tiles():
        path = filedialog.askdirectory(title="Select DEM_tiles folder")
        if path:
            dem_tiles_dir.set(path)

    tk.Button(dem_row, text="Browse...", command=choose_dem_tiles).pack(side="left", padx=(6, 0))

    # Two zones instead of one flat list -- each table lands in "Glacier" or
    # "Climate" automatically based on its filename (categorize(), the same
    # rule used later for the variable picker's grouping), so it's obvious
    # at a glance which bucket a table will show up under in the viewer.
    tk.Label(root, text="Tables (parquet / csv)", anchor="w").pack(fill="x", padx=10, pady=(14, 0))
    tables_row = tk.Frame(root)
    tables_row.pack(fill="both", expand=True, padx=10)

    def _make_zone(parent, title):
        zone = tk.Frame(parent)
        tk.Label(zone, text=title, anchor="w", font=("", 9, "bold")).pack(fill="x")
        list_frame = tk.Frame(zone)
        list_frame.pack(fill="both", expand=True)
        lb = tk.Listbox(list_frame, selectmode=tk.EXTENDED)
        lb.pack(side="left", fill="both", expand=True)
        sb = tk.Scrollbar(list_frame, command=lb.yview)
        sb.pack(side="right", fill="y")
        lb.config(yscrollcommand=sb.set)
        return zone, lb

    glacier_zone, glacier_lb = _make_zone(tables_row, "Glacier")
    climate_zone, climate_lb = _make_zone(tables_row, "Climate")
    glacier_zone.pack(side="left", fill="both", expand=True, padx=(0, 6))
    climate_zone.pack(side="left", fill="both", expand=True, padx=(6, 0))

    # path -> which listbox currently shows it, kept in sync with table_paths
    path_listbox: dict[str, tk.Listbox] = {}

    def _listbox_for(path: str) -> tk.Listbox:
        return climate_lb if categorize(Path(path).name) == "climate" else glacier_lb

    def _add_path(path: str):
        if path in table_paths:
            return
        table_paths.append(path)
        lb = _listbox_for(path)
        path_listbox[path] = lb
        lb.insert("end", Path(path).name)

    table_paths_initial = list(table_paths)
    table_paths.clear()
    for p in table_paths_initial:
        _add_path(p)

    def add_tables():
        paths = filedialog.askopenfilenames(
            title="Select tables", filetypes=[("Data tables", "*.parquet *.csv")]
        )
        for p in paths:
            _add_path(p)

    def remove_selected():
        for lb in (glacier_lb, climate_lb):
            for i in reversed(lb.curselection()):
                name = lb.get(i)
                lb.delete(i)
                for path in list(table_paths):
                    if Path(path).name == name and path_listbox.get(path) is lb:
                        table_paths.remove(path)
                        del path_listbox[path]
                        break

    button_row = tk.Frame(root)
    button_row.pack(fill="x", padx=10, pady=6)
    tk.Button(button_row, text="Add tables...", command=add_tables).pack(side="left")
    tk.Button(button_row, text="Remove selected", command=remove_selected).pack(side="left", padx=6)

    data_exists = (Path(__file__).resolve().parent.parent / "viewer" / "data" / "index.json").exists()

    rebuild_var = tk.BooleanVar(value=not data_exists)
    rebuild_check = tk.Checkbutton(
        root, text="Rebuild cache even if the selection is unchanged", variable=rebuild_var
    )
    rebuild_check.pack(anchor="w", padx=10)
    if not data_exists:
        rebuild_check.config(state="disabled")  # nothing to skip to yet, must build

    status = tk.StringVar(
        value="Pick files, or keep the last selection, then Start."
        if data_exists
        else "No cache built yet -- pick files, then Start."
    )
    tk.Label(root, textvariable=status, fg="#666", anchor="w").pack(fill="x", padx=10)

    result: dict = {}

    def on_start():
        if not gpkg_path.get():
            messagebox.showerror("Missing file", "Select the glacier_evolution_full.gpkg file first.")
            return
        if not dem_tiles_dir.get():
            messagebox.showerror("Missing folder", "Select the DEM_tiles folder first.")
            return
        if not table_paths:
            messagebox.showerror("Missing tables", "Add at least one parquet/csv table.")
            return
        result["gpkg"] = Path(gpkg_path.get())
        result["dem_tiles"] = Path(dem_tiles_dir.get())
        result["tables"] = [Path(p) for p in table_paths]
        result["rebuild"] = rebuild_var.get()
        root.destroy()

    tk.Button(root, text="Start", command=on_start, bg="#2a6fb0", fg="white").pack(pady=10)

    root.mainloop()

    if "gpkg" not in result:
        raise SystemExit("Cancelled.")

    selection_unchanged = (
        str(result["gpkg"]) == remembered.get("gpkg", "")
        and str(result["dem_tiles"]) == remembered.get("dem_tiles", "")
        and [str(p) for p in result["tables"]] == remembered.get("tables", [])
    )
    needs_rebuild = result["rebuild"] or not selection_unchanged or not data_exists
    return result["gpkg"], result["dem_tiles"], result["tables"], needs_rebuild


CLIMATE_KEYWORDS = (
    "climat", "temperature", "precip", "snow", "radiation",
    "sst", "teleconnection", "wind", "aod", "atmos", "fire", "mass_balance",
    "aar_", "pressure", "humidity", "vpd", "era5", "terraclimate", "daymet",
    "worldclim", "koppen", "permafrost", "terrain",
)


def categorize(filename: str) -> str:
    lower = filename.lower()
    if any(k in lower for k in CLIMATE_KEYWORDS):
        return "climate"
    return "glacier"


def normalize(df: pl.DataFrame) -> pl.DataFrame:
    renames = {}
    if "glims_id" in df.columns and "id_glims" not in df.columns:
        renames["glims_id"] = "id_glims"
    if "annee" in df.columns and "year" not in df.columns:
        renames["annee"] = "year"
    return df.rename(renames) if renames else df


def read_table(path: Path) -> pl.DataFrame:
    if path.suffix == ".parquet":
        return normalize(pl.read_parquet(path))
    return normalize(pl.read_csv(path))


TEXT_BLOB_HINTS = ("json", "params", "feature_list", "reason")


def classify_column(df: pl.DataFrame, col: str) -> dict:
    """Rough dtype/plottable hint per column, so the picker can skip IDs,
    free-text, and JSON blobs instead of listing every column flat."""
    dtype = df.schema[col]
    lower = col.lower()

    if dtype == pl.Boolean:
        return {"dtype": "flag", "plottable": True}

    if dtype in (pl.Utf8, pl.String):
        if any(h in lower for h in TEXT_BLOB_HINTS):
            return {"dtype": "text", "plottable": False}
        sample = df[col].drop_nulls()
        if sample.len() == 0:
            return {"dtype": "text", "plottable": False}
        avg_len = sample.cast(pl.Utf8).str.len_chars().mean() or 0
        if avg_len > 40:
            return {"dtype": "text", "plottable": False}
        if sample.n_unique() <= 30:
            return {"dtype": "categorical", "plottable": True}
        return {"dtype": "id", "plottable": False}

    if dtype.is_numeric():
        if lower.endswith("_id") or lower in ("group_id", "class_id"):
            return {"dtype": "id", "plottable": False}
        return {"dtype": "numeric", "plottable": True}

    return {"dtype": "other", "plottable": False}


def build_sources_meta(table_paths: list[Path]) -> tuple[dict[str, dict], list[dict]]:
    """One pass per table: classifies its columns for the variable picker
    (sources.json) and, opportunistically, harvests id/lon/lat for the
    world map (index.json) -- without keeping the full per-glacier content
    of any table in memory or writing it out. serve.py re-reads a table's
    actual rows lazily, straight from its source path, only if a glacier
    that's actually clicked has data in it.
    """
    sources: dict[str, dict] = {}
    id_union: set[str] = set()
    lon_lat_by_id: dict[str, tuple] = {}

    for path in table_paths:
        df = read_table(path)
        if "id_glims" not in df.columns:
            print(f"skip {path.name}: no id_glims/glims_id column")
            continue

        is_temporal = "year" in df.columns
        excluded = {"id_glims", "year"}
        value_cols = [c for c in df.columns if c not in excluded]
        columns_meta = {c: classify_column(df, c) for c in value_cols}

        sources[path.name] = {
            "kind": "temporal" if is_temporal else "static",
            "category": categorize(path.name),
            "columns": columns_meta,
        }
        print(f"{path.name}: {'temporal' if is_temporal else 'static'}, {df.height:,} rows, {len(value_cols)} columns")

        id_union.update(df["id_glims"].unique().to_list())
        if not lon_lat_by_id and "centroid_lon" in df.columns and "centroid_lat" in df.columns:
            lon_lat_df = df.select(["id_glims", "centroid_lon", "centroid_lat"]).unique(subset=["id_glims"])
            for row in lon_lat_df.to_dicts():
                lon_lat_by_id[row["id_glims"]] = (row["centroid_lon"], row["centroid_lat"])

    index_rows = [
        {
            "id_glims": gid,
            "centroid_lon": lon_lat_by_id.get(gid, (None, None))[0],
            "centroid_lat": lon_lat_by_id.get(gid, (None, None))[1],
        }
        for gid in sorted(id_union)
    ]
    return sources, index_rows


def find_gpkg_index_rows(gpkg_path: Path) -> list[dict]:
    """Fallback when none of the selected tables carry lon/lat: pulls just
    (id, lon, lat) from the GeoPackage without touching the geometry column
    at all (no ST_AsGeoJSON), so it stays fast even on the combined
    glacier_evolution layer -- the expensive per-row geometry conversion
    only ever happens lazily, per glacier, in serve.py. Prefers the
    sgv_ref row's centroid (the fixed reference footprint) when present,
    falling back to any row for glaciers that don't have one."""
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    rows = con.execute(
        f"""
        SELECT glims_id AS id_glims,
               coalesce(
                   any_value(centroid_lon) FILTER (feature_type = 'sgv_ref'),
                   any_value(centroid_lon)
               ) AS centroid_lon,
               coalesce(
                   any_value(centroid_lat) FILTER (feature_type = 'sgv_ref'),
                   any_value(centroid_lat)
               ) AS centroid_lat
        FROM ST_Read('{gpkg_path.as_posix()}', layer='glacier_evolution')
        GROUP BY glims_id
        """
    ).pl()
    con.close()
    return rows.sort("id_glims").to_dicts()


DEFAULT_OUT = Path(__file__).resolve().parent.parent / "viewer" / "data"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build viewer/data from selected source files")
    parser.add_argument("--gpkg", help="Path to glacier_evolution_full.gpkg")
    parser.add_argument("--dem-tiles", help="Path to the DEM_tiles folder")
    parser.add_argument("--tables", nargs="*", help="Parquet/csv tables to include")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output directory")
    args = parser.parse_args()

    launch_after = False
    if args.gpkg and args.dem_tiles and args.tables:
        gpkg_path = Path(args.gpkg)
        dem_tiles_dir = Path(args.dem_tiles)
        table_paths = [Path(p) for p in args.tables]
        needs_rebuild = True
    else:
        gpkg_path, dem_tiles_dir, table_paths, needs_rebuild = pick_files_gui()
        save_last_selection(gpkg_path, dem_tiles_dir, table_paths)
        launch_after = True

    if not needs_rebuild:
        print("Selection unchanged, cache already built -- skipping straight to the viewer.")
        launch_viewer()
        return 0

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Reading selected tables...")
    sources, index_rows = build_sources_meta(table_paths)

    if not any(row["centroid_lon"] is not None for row in index_rows):
        print("No lon/lat in the selected tables -- querying the GeoPackage for glacier locations...")
        index_rows = find_gpkg_index_rows(gpkg_path)

    write_json(out_dir / "index.json", index_rows)
    write_json(out_dir / "sources.json", sources)
    write_json(out_dir / "manifest.json", {
        "gpkg": str(gpkg_path),
        "dem_tiles": str(dem_tiles_dir),
        "tables": [str(p) for p in table_paths],
    })
    print(f"{len(index_rows):,} glaciers")
    print("Done -- per-glacier geometry, DEM, and classification data load on demand when a glacier is selected in the viewer.")

    if launch_after:
        launch_viewer()

    return 0


def launch_viewer(port: int = 8000) -> None:
    """Starts the viewer server and opens it in the browser. Blocks until
    the server process exits (Ctrl+C, or closing the console).

    Runs serve.py with the *current* interpreter (sys.executable), not the
    bundled minimal runtime under viewer/runtime -- serve.py now reads
    per-glacier data lazily straight from the source GeoPackage/tables
    (duckdb, pyproj, rasterio, polars), so it needs the same conda env
    ingest.py itself runs in, not a stdlib-only runtime.
    """
    import subprocess
    import sys
    import threading
    import time
    import webbrowser

    viewer_dir = Path(__file__).resolve().parent.parent / "viewer"

    proc = subprocess.Popen([sys.executable, "serve.py", str(port)], cwd=str(viewer_dir))

    def open_browser():
        time.sleep(1.0)
        webbrowser.open(f"http://localhost:{port}")

    threading.Thread(target=open_browser, daemon=True).start()

    print(f"Viewer running at http://localhost:{port} -- close this window to stop.")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
