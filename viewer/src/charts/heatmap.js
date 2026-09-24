import { freshChart, RESET_ZOOM_TOOLBOX } from "./chart_util.js";

const HEATMAP_COLORS = ["#ffffff", "#ffe0a3", "#e05a2e", "#7a0d0d"];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Approximates echarts' own gradient interpolation so the tooltip can show
// a color swatch that actually matches what's painted on the cell under the
// cursor, instead of plain unstyled text.
function colorForValue(v, maxValue) {
  if (maxValue <= 0) return HEATMAP_COLORS[0];
  const t = Math.max(0, Math.min(1, v / maxValue)) * (HEATMAP_COLORS.length - 1);
  const i = Math.min(HEATMAP_COLORS.length - 2, Math.floor(t));
  const frac = t - i;
  const [r1, g1, b1] = hexToRgb(HEATMAP_COLORS[i]);
  const [r2, g2, b2] = hexToRgb(HEATMAP_COLORS[i + 1]);
  const r = Math.round(r1 + (r2 - r1) * frac);
  const g = Math.round(g1 + (g2 - g1) * frac);
  const b = Math.round(b1 + (b2 - b1) * frac);
  return `rgb(${r},${g},${b})`;
}

// Footprint rings are in (col, row) pixel space (see loadOutlinePixel) while
// the heatmap cells are indexed as category axis ticks (0, 1, 2, ...) --
// same integer values, just plotted on a "value" axis pair overlaid on top
// via a second grid/axis pair sharing the same pixel extent.
function extractPixelRings(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const rings = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, i) => {
      rings.push({ points: ring.map(([col, row]) => [col, row]), isExterior: i === 0 });
    });
  }
  return rings;
}

export function renderHeatmap(container, changeHeatmap, outlinePixel) {
  const chart = freshChart(container);
  const {
    height, width, values,
    cloud_years: cloudYears, n_years: nYears,
    footprint_masked: footprintMasked,
  } = changeHeatmap;

  // Every Other/Snow/Ice state change counts as a surface change (server
  // side) -- only cloud-excluded years are skipped, comparing each
  // pixel's most recent real observation against the next one across any
  // gap.
  //
  // Pixels outside the sgv_ref footprint are forced cloud-excluded for
  // every single year server-side (see serve.py's footprint_outside_mask)
  // whenever footprintMasked is true -- cloud_years === n_years for a
  // pixel in that case means "outside the glacier", not "unluckily
  // cloudy every year", so those cells are skipped entirely (no heatmap
  // cell drawn) instead of being colored as a change count of 0, which
  // read as part of the same color scale as real in-glacier data.
  const data = [];
  let maxValue = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const cloudCount = cloudYears ? cloudYears[idx] : 0;
      if (footprintMasked && cloudCount === nYears) continue;
      const v = values[idx];
      if (v > maxValue) maxValue = v;
      data.push([col, row, v, cloudCount]);
    }
  }

  const colLabels = Array.from({ length: width }, (_, i) => String(i));
  const rowLabels = Array.from({ length: height }, (_, i) => String(i));

  const series = [
    {
      type: "heatmap",
      xAxisIndex: 0,
      yAxisIndex: 0,
      data,
      itemStyle: { borderWidth: 0 },
      emphasis: { itemStyle: { borderWidth: 1, borderColor: "#333" } },
    },
  ];

  const xAxis = [{ type: "category", data: colLabels, show: false }];
  const yAxis = [{ type: "category", data: rowLabels, show: false, inverse: true }];

  if (outlinePixel) {
    // Overlaid on a second value-axis pair spanning the same pixel extent
    // as the category axes above, 0.5-cell-centered like the category axis
    // itself would be -- close enough at this resolution to trace the
    // footprint directly over the heatmap cells.
    xAxis.push({ type: "value", min: 0, max: width, show: false, gridIndex: 0 });
    yAxis.push({ type: "value", min: 0, max: height, inverse: true, show: false, gridIndex: 0 });
    for (const { points } of extractPixelRings(outlinePixel.geometry)) {
      series.push({
        name: "footprint",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points,
        showSymbol: false,
        lineStyle: { color: "#2a2a2a", width: 2 },
        z: 5,
        silent: true,
        tooltip: { show: false },
      });
    }
  }

  chart.setOption({
    title: footprintMasked
      ? {
          text: "Surface changes (Other/Snow/Ice) inside the glacier footprint, carried across any cloud-excluded years in between",
          top: 0,
          left: "center",
          textStyle: { fontSize: 11, color: "#666", fontWeight: "normal" },
        }
      : {
          text: "No footprint available for this glacier -- showing the RAW raster, including background outside the glacier (not masked)",
          top: 0,
          left: "center",
          textStyle: { fontSize: 11, color: "#a06a00", fontWeight: "normal" },
        },
    grid: { top: 26, bottom: 60, left: 10, right: 10, containLabel: false },
    xAxis,
    yAxis,
    dataZoom: outlinePixel
      ? [{ type: "inside", xAxisIndex: [0, 1] }, { type: "inside", yAxisIndex: [0, 1] }]
      : [{ type: "inside", xAxisIndex: [0] }, { type: "inside", yAxisIndex: [0] }],
    toolbox: RESET_ZOOM_TOOLBOX,
    visualMap: {
      seriesIndex: 0,
      // Without an explicit dimension, visualMap defaults to the LAST
      // value in each data point -- data here is [col, row, changeCount,
      // cloudCount], so the color was driven by cloudCount (dimension 3)
      // instead of the actual change count (dimension 2). That's exactly
      // why the color only ever moved with cloud-excluded years.
      dimension: 2,
      min: 0,
      max: Math.max(maxValue, 1),
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 10,
      inRange: { color: HEATMAP_COLORS },
    },
    series,
    tooltip: {
      formatter: (p) => {
        const swatch = `<span style="display:inline-block;width:10px;height:10px;margin-right:4px;border:1px solid #999;background:${colorForValue(p.data[2], maxValue)}"></span>`;
        const cloudInfo = nYears
          ? `<br/>${p.data[3]} of ${nYears} years cloud-excluded (not counted as changes)`
          : "";
        return `${swatch}X ${p.data[0]}, Y ${p.data[1]}: ${p.data[2]} change(s)${cloudInfo}`;
      },
    },
  });

  return chart;
}
