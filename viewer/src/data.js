const cache = new Map();

async function fetchJson(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch failed: ${path}`);
  const value = await res.json();
  cache.set(path, value);
  return value;
}

async function fetchBinary(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch failed: ${path}`);
  const value = await res.arrayBuffer();
  cache.set(path, value);
  return value;
}

export function loadIndex() {
  return fetchJson("data/index.json");
}

export function loadSources() {
  return fetchJson("data/sources.json");
}

export function loadMeta(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/meta.json`);
}

export function loadYearSeries(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/year_series.json`);
}

export function loadGeomSeries(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/geom_series.json`);
}

export function loadOutline(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/outline.geojson`);
}

// Same footprint as loadOutline, but reprojected into DEM pixel (col, row)
// space -- lets the outline be drawn directly on top of the DEM raster.
// Only present for glaciers that had geo_meta (CRS + affine transform) in
// the source GeoPackage, so this can 404 -- callers should treat that as
// "no DEM overlay for this glacier", not an error.
export function loadOutlinePixel(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/outline_pixel.geojson`);
}

export function loadOutlinesInBbox(minLon, minLat, maxLon, maxLat) {
  const params = new URLSearchParams({
    min_lon: minLon, min_lat: minLat, max_lon: maxLon, max_lat: maxLat,
  });
  return fetch(`data/outlines_bbox.json?${params}`).then((res) => {
    if (!res.ok) throw new Error(`fetch failed: outlines_bbox.json`);
    return res.json();
  });
}

export function loadChangeHeatmap(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/change_heatmap.json`);
}

export async function loadDem(idGlims) {
  const [meta, buf] = await Promise.all([
    fetchJson(`data/glaciers/${idGlims}/dem_meta.json`),
    fetchBinary(`data/glaciers/${idGlims}/dem.bin`),
  ]);
  return { ...meta, values: new Float32Array(buf) };
}

// Unclipped DEM (full raster extent, not cut to the sgv_ref footprint) --
// used by the centroid charts, which show surrounding terrain for context
// with the footprint drawn as an outline on top instead of clipped away.
export async function loadDemFull(idGlims) {
  const [meta, buf] = await Promise.all([
    fetchJson(`data/glaciers/${idGlims}/dem_full_meta.json`),
    fetchBinary(`data/glaciers/${idGlims}/dem_full.bin`),
  ]);
  return { ...meta, values: new Float32Array(buf) };
}

export function loadAltitudeEvolution(idGlims) {
  return fetchJson(`data/glaciers/${idGlims}/altitude_evolution.json`);
}

export async function loadSgvStack(idGlims) {
  const [meta, buf] = await Promise.all([
    fetchJson(`data/glaciers/${idGlims}/sgv_stack_meta.json`),
    fetchBinary(`data/glaciers/${idGlims}/sgv_stack.bin`),
  ]);
  return { ...meta, values: new Uint8Array(buf) };
}
