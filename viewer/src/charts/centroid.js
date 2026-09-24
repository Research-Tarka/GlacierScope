import { buildDemHeatmapLayer } from "./dem_layer.js";
import { driftTrajectory } from "./drift.js";
import { freshChart, RESET_ZOOM_TOOLBOX } from "./chart_util.js";
import { extractRings } from "./outline.js";

// Matches the reference centroid-drift rendering: dark saturated colors
// for the drift trajectory, lighter/translucent colors for the raw yearly
// points, distinct symbols per feature.
const COLORS = { sgv: "#d4a300", snow: "#1f77b4", ice: "#ff7f0e" };
const LIGHT_COLORS = { sgv: "#f3d77a", snow: "#9ecae9", ice: "#ffbb78" };
const SYMBOLS = { sgv: "circle", snow: "diamond", ice: "rect" };
// Every feature type gets its own points + trajectory, in every case --
// there's always something to draw a drift curve through, not just when
// snow/ice happen to be present.
const DRIFT_TYPES = ["sgv", "snow", "ice"];

function seriesFor(geomSeries, featureType) {
  return geomSeries
    .filter((row) => row.feature_type === featureType)
    .sort((a, b) => a.year - b.year);
}

function hasPixelCoords(geomSeries) {
  return geomSeries.length > 0 && geomSeries[0].centroid_col !== undefined;
}

function dataRange(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return null;
  return [Math.min(...finite), Math.max(...finite)];
}

export function renderCentroid2D(container, geomSeries, dem, outlinePixel) {
  const chart = freshChart(container);
  const usePixel = dem && hasPixelCoords(geomSeries);
  const xKey = usePixel ? "centroid_col" : "centroid_lon";
  const yKey = usePixel ? "centroid_row" : "centroid_lat";
  const overlayAxis = usePixel ? { xAxisIndex: 1, yAxisIndex: 1 } : {};

  const series = [];
  const legendData = [];
  let dem2d = null;

  if (usePixel) {
    dem2d = buildDemHeatmapLayer(dem);
    series.push(dem2d.series);
    legendData.push("elevation");

    // Footprint drawn as a line only (no fill) over the full, unclipped
    // DEM -- shows where the glacier sits in its surrounding terrain
    // instead of cutting the terrain away.
    if (outlinePixel) {
      for (const { points, isExterior } of extractRings(outlinePixel.geometry)) {
        series.push({
          name: "sgv_ref footprint",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: points,
          showSymbol: false,
          lineStyle: { color: "#2a6fb0", width: 2 },
          z: 3,
          silent: true,
          tooltip: { show: false },
        });
        if (isExterior) legendData.push("sgv_ref footprint");
      }
    }
  }

  const allX = [];
  const allY = [];

  for (const featureType of ["sgv", "snow", "ice"]) {
    const rows = seriesFor(geomSeries, featureType);
    for (const r of rows) {
      allX.push(r[xKey]);
      allY.push(r[yKey]);
    }

    series.push({
      name: featureType,
      type: "scatter",
      data: rows.map((r) => [r[xKey], r[yKey], r.year]),
      symbol: SYMBOLS[featureType],
      symbolSize: 7,
      itemStyle: { color: LIGHT_COLORS[featureType], opacity: 0.7 },
      z: 2,
      ...overlayAxis,
    });
    legendData.push(featureType);

    if (!DRIFT_TYPES.includes(featureType)) continue;
    const drift = driftTrajectory(rows, [xKey, yKey]);
    if (!drift) continue;

    // Same legend name as the feature's own point series above -- so
    // toggling that legend entry off hides the trajectory line and tip
    // marker together with the points.
    series.push({
      name: featureType,
      type: "line",
      data: drift.curve,
      showSymbol: false,
      lineStyle: { color: COLORS[featureType], width: 3 },
      z: 3,
      ...overlayAxis,
      tooltip: { show: false },
    });

    // A plain circle at the curve's tip, matching the 3D chart's tip
    // marker -- a rotated arrow symbol here was unreliable (its heading
    // could end up pointing opposite to the curve depending on axis
    // orientation) and a dot conveys "recent position" just as well
    // without needing a direction to get right.
    series.push({
      name: featureType,
      type: "scatter",
      data: [drift.tip],
      symbol: "circle",
      symbolSize: 12,
      itemStyle: { color: COLORS[featureType], borderColor: "#fff", borderWidth: 1.5, opacity: 1 },
      z: 4,
      ...overlayAxis,
      tooltip: {
        formatter: () => `${featureType} displacement`,
      },
    });
  }

  const xRange = dataRange(allX);
  const yRange = dataRange(allY);

  const options = {
    xAxis: usePixel
      ? [dem2d.xAxisCategory, dem2d.xAxisValue]
      : { type: "value", scale: true, name: "lon", min: xRange ? xRange[0] : undefined, max: xRange ? xRange[1] : undefined },
    yAxis: usePixel
      ? [dem2d.yAxisCategory, dem2d.yAxisValue]
      : { type: "value", scale: true, name: "lat", min: yRange ? yRange[0] : undefined, max: yRange ? yRange[1] : undefined },
    legend: usePixel ? { data: legendData, selected: { elevation: true } } : { data: legendData },
    dataZoom: usePixel
      ? [{ type: "inside", xAxisIndex: [0, 1] }, { type: "inside", yAxisIndex: [0, 1] }]
      : [{ type: "inside" }],
    toolbox: RESET_ZOOM_TOOLBOX,
    tooltip: {
      formatter: (p) => `${p.marker || ""}${p.seriesName}, year ${p.data[2]}`,
    },
    series,
  };
  if (usePixel) options.visualMap = dem2d.visualMap;
  chart.setOption(options);

  return chart;
}

export function renderCentroid3D(container, geomSeries, dem, outlinePixel) {
  const chart = freshChart(container);
  const usePixel = dem && hasPixelCoords(geomSeries);
  const xKey = usePixel ? "centroid_col" : "centroid_lon";
  const yKey = usePixel ? "centroid_row" : "centroid_lat";

  const series = [];
  const legendData = [];
  let demSeriesIndex = -1;
  let demMin = 0;
  let demMax = 1;

  if (usePixel) {
    const { height, width, values } = dem;
    const surfaceData = [];
    demMin = Infinity;
    demMax = -Infinity;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const z = values[row * width + col];
        if (Number.isNaN(z)) {
          surfaceData.push([col, row, null]);
        } else {
          surfaceData.push([col, row, z]);
          if (z < demMin) demMin = z;
          if (z > demMax) demMax = z;
        }
      }
    }
    if (!Number.isFinite(demMin)) demMin = 0;
    if (!Number.isFinite(demMax)) demMax = 1;

    demSeriesIndex = series.length;
    series.push({
      name: "elevation",
      type: "surface",
      data: surfaceData,
      wireframe: { show: false },
      itemStyle: { opacity: 0.6 },
      shading: "lambert",
      silent: true,
    });
    legendData.push("elevation");

    // Footprint drawn as a 3D line draped on the DEM surface (no fill),
    // over the full unclipped terrain -- replaces the old flat green
    // "glacier extent" overlay, which had no legend entry and only ever
    // covered part of the footprint (whichever pixels were snow/ice in the
    // most recent year), reading as an unexplained stray patch of green.
    if (outlinePixel) {
      // Looks up the DEM value at (col, row), or -- when that pixel is out
      // of the raster's bounds or itself nodata -- the nearest in-bounds,
      // non-NaN pixel instead. The footprint outline runs right along the
      // DEM's real edge and through small nodata gaps; without this, those
      // points fell back to demMin (the glacier's lowest elevation) and the
      // draped line plunged straight down to it, instead of continuing to
      // follow the terrain it's actually sitting on.
      function nearestDemZ(col, row) {
        if (col >= 0 && col < width && row >= 0 && row < height) {
          const z = values[row * width + col];
          if (!Number.isNaN(z)) return z;
        }
        let best = null;
        let bestDist = Infinity;
        for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
            const z = values[r * width + c];
            if (Number.isNaN(z)) continue;
            const dist = (c - col) ** 2 + (r - row) ** 2;
            if (dist < bestDist) {
              bestDist = dist;
              best = z;
            }
          }
        }
        return best === null ? demMin : best;
      }

      for (const { points, isExterior } of extractRings(outlinePixel.geometry)) {
        if (!isExterior) continue;
        const draped = points.map(([x, y]) => {
          const col = Math.round(x);
          const row = Math.round(y);
          return [x, y, nearestDemZ(col, row)];
        });
        series.push({
          name: "sgv_ref footprint",
          type: "line3D",
          data: draped,
          lineStyle: { color: "#2a6fb0", width: 4 },
          tooltip: { show: false },
        });
      }
      legendData.push("sgv_ref footprint");
    }
  }

  for (const featureType of ["sgv", "snow", "ice"]) {
    const rows = seriesFor(geomSeries, featureType);

    series.push({
      name: featureType,
      type: "scatter3D",
      data: rows.map((r) => [r[xKey], r[yKey], r.elevation_m, r.year]),
      symbol: SYMBOLS[featureType],
      itemStyle: { color: LIGHT_COLORS[featureType], opacity: 0.6 },
      symbolSize: 4,
    });
    legendData.push(featureType);

    if (!DRIFT_TYPES.includes(featureType)) continue;
    const drift = driftTrajectory(rows, [xKey, yKey, "elevation_m"]);
    if (!drift) continue;

    // Matches the reference's smooth polynomial trajectory (a line3D
    // through the interpolated curve, same as the reference's Scatter3d
    // "lines" trace) with a marker at the tip identifying recent direction.
    // Named after the same featureType (not its own "X trajectory" legend
    // entry) so toggling that one legend checkbox hides the points, the
    // trajectory line, AND the tip marker together -- giving the tip its
    // own separate series name left it visible (with its own untoggleable
    // dot) even after switching the feature's legend entry off.
    series.push({
      name: featureType,
      type: "line3D",
      data: drift.curve,
      lineStyle: { color: COLORS[featureType], width: 6 },
      tooltip: { show: false },
    });
    series.push({
      name: featureType,
      type: "scatter3D",
      data: [drift.tip],
      symbol: "circle",
      symbolSize: 12,
      itemStyle: { color: COLORS[featureType], borderColor: "#fff", borderWidth: 1.5, opacity: 1 },
      tooltip: {
        formatter: () => `${featureType} displacement`,
      },
    });
  }

  // Fixed z-axis range, same whether or not the DEM series is toggled off
  // in the legend -- otherwise the axis rescales itself to just the
  // centroid points' elevation range when "elevation" is hidden, so the
  // same glacier shows two different axis scales depending on what's
  // toggled, which reads as broken. Falls back to the centroid points'
  // own elevation range when there's no DEM at all.
  let zMin = demMin;
  let zMax = demMax;
  if (demSeriesIndex < 0) {
    const elevs = geomSeries.map((r) => r.elevation_m).filter((v) => Number.isFinite(v));
    if (elevs.length) {
      zMin = Math.min(...elevs);
      zMax = Math.max(...elevs);
    }
  }

  const options = {
    xAxis3D: { type: "value", name: usePixel ? "X" : "lon" },
    yAxis3D: { type: "value", name: usePixel ? "Y" : "lat" },
    zAxis3D: { type: "value", name: "elevation (m)", min: zMin, max: zMax },
    grid3D: {
      viewControl: { zoomSensitivity: 5 },
      axisLabel: { show: true },
      axisLine: { show: true },
      boxHeight: 60,
    },
    legend: usePixel ? { data: legendData, selected: { elevation: true } } : { data: legendData },
    tooltip: {
      formatter: (p) => {
        if (p.seriesName === "elevation" || p.seriesName === "sgv_ref footprint") {
          return p.data[2] == null ? "elevation n/a" : `elevation ${p.data[2].toFixed(0)} m`;
        }
        return `${p.marker || ""}${p.seriesName}, year ${p.data[3]}<br/>elevation ${p.data[2]} m`;
      },
    },
    series,
  };
  // Positioned top-right instead of overlapping the z-axis's own label
  // column on the left, which is what was making axis numbers unreadable
  // whenever the DEM (and this legend) was shown.
  if (demSeriesIndex >= 0) {
    options.visualMap = {
      show: true,
      dimension: 2,
      seriesIndex: demSeriesIndex,
      min: demMin,
      max: demMax,
      calculable: true,
      orient: "vertical",
      right: 10,
      top: "middle",
      itemHeight: 120,
      inRange: { color: ["#eeeeee", "#242424"] },
      formatter: (v) => `${Math.round(v)} m`,
    };
  }
  chart.setOption(options);

  return chart;
}
