// One CSV-shaping function per figure, each reading straight from the same
// source data the chart itself was rendered from (not from the echarts
// option) -- so column names describe the actual variables (year,
// area_m2, elevation_m, ...) instead of a chart's internal series/dimension
// layout.

const CLASS_LABELS = ["Other", "Snow", "Ice", "Cloud (excluded)", "Outside footprint"];

// --- Outline: ring points of the sgv_ref (or fallback) footprint -----------
export function outlineCsv(outline) {
  const geometry = outline.geometry;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const rows = [];
  polygons.forEach((polygon, ringGroupIndex) => {
    polygon.forEach((ring, ringIndex) => {
      ring.forEach(([lon, lat], pointIndex) => {
        rows.push({
          ring_group: ringGroupIndex,
          ring_index: ringIndex,
          is_exterior: ringIndex === 0,
          point_index: pointIndex,
          lon,
          lat,
        });
      });
    });
  });
  return {
    columns: ["ring_group", "ring_index", "is_exterior", "point_index", "lon", "lat"],
    rows,
  };
}

// --- Centroid 2D/3D: geomSeries rows, one row per feature_type/year --------
export function centroidCsv(geomSeries) {
  return {
    columns: [
      "feature_type", "year", "centroid_lon", "centroid_lat",
      "elevation_m", "displacement_from_ref_m",
    ],
    rows: geomSeries
      .slice()
      .sort((a, b) => a.feature_type.localeCompare(b.feature_type) || a.year - b.year),
  };
}

// --- Area evolution (temporal): area_m2 per feature_type/year --------------
export function evolutionTemporalCsv(geomSeries) {
  return {
    columns: ["feature_type", "year", "area_m2"],
    rows: geomSeries
      .slice()
      .sort((a, b) => a.feature_type.localeCompare(b.feature_type) || a.year - b.year)
      .map((r) => ({ feature_type: r.feature_type, year: r.year, area_m2: r.area_m2 })),
  };
}

// --- Area evolution 2D/3D: full per-pixel classification stack -------------
// One row per (year, row, col) -- this is the same data the 2D/3D scrubber
// charts step through frame by frame, just flattened. Can be large (n_years
// x height x width rows) for a big glacier, same as the underlying
// sgv_stack.bin payload already transferred to render the chart.
export function evolutionSpatialCsv(sgvStack) {
  const { years, height, width, values } = sgvStack;
  const rows = [];
  for (let t = 0; t < years.length; t++) {
    const offset = t * height * width;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const cls = values[offset + row * width + col];
        rows.push({ year: years[t], row, col, class: CLASS_LABELS[cls] || cls });
      }
    }
  }
  return { columns: ["year", "row", "col", "class"], rows };
}

// --- Fraction evolution: the three glacier_year_state.parquet columns ------
export function fractionEvolutionCsv(yearSeries) {
  const rows = (yearSeries["glacier_year_state.parquet"] || []).slice().sort((a, b) => a.year - b.year);
  return {
    columns: ["year", "snow_fraction", "snow_fraction_vgs", "vgs_fraction_ref"],
    rows: rows.map((r) => ({
      year: r.year,
      snow_fraction: r.snow_fraction,
      snow_fraction_vgs: r.snow_fraction_vgs,
      vgs_fraction_ref: r.vgs_fraction_ref,
    })),
  };
}

// --- Altitude evolution: two sheets -- per-group pixel stats, and the TSL
// proxy series -- since they're logically different tables (one row per
// connected pixel group vs one row per year), not one row per year each.
export function altitudeEvolutionCsv(altitudeEvolution) {
  const { accumulation, ablation, tsl } = altitudeEvolution;
  const groupRows = [
    ...accumulation.map((p) => ({ group_type: "snow", ...p })),
    ...ablation.map((p) => ({ group_type: "ice", ...p })),
  ].sort((a, b) => a.year - b.year);

  return {
    pixel_groups: {
      columns: ["group_type", "year", "mean", "min", "max", "pixelCount"],
      rows: groupRows.map((r) => ({
        group_type: r.group_type,
        year: r.year,
        mean: r.mean,
        min: r.min,
        max: r.max,
        pixelCount: r.pixelCount,
      })),
    },
    tsl: {
      columns: ["year", "tsl_proxy_m"],
      rows: tsl.map(([year, value]) => ({ year, tsl_proxy_m: value })),
    },
  };
}

// --- Change heatmap: per-pixel surface-change count + cloud-excluded years -
export function changeHeatmapCsv(changeHeatmap) {
  const { height, width, values, cloud_years: cloudYears } = changeHeatmap;
  const rows = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      rows.push({ row, col, change_count: values[idx], cloud_excluded_years: cloudYears ? cloudYears[idx] : 0 });
    }
  }
  return { columns: ["row", "col", "change_count", "cloud_excluded_years"], rows };
}
