import { freshChart, RESET_ZOOM_TOOLBOX } from "./chart_util.js";

// Reads straight from glacier_year_state.parquet (already ingested into
// yearSeries) -- no computation here, just the three existing fraction
// columns overlaid on one chart.
const SERIES_DEF = [
  { key: "snow_fraction", name: "snow fraction", color: "#3b7fc9" },
  { key: "snow_fraction_vgs", name: "snow fraction (sgv)", color: "#00c853" },
  { key: "vgs_fraction_ref", name: "sgv fraction (ref)", color: "#c9a300" },
];

export function renderFractionEvolution(container, yearSeries) {
  const chart = freshChart(container);

  const rows = (yearSeries["glacier_year_state.parquet"] || []).slice().sort((a, b) => a.year - b.year);

  const series = SERIES_DEF.map(({ key, name, color }) => ({
    name,
    type: "line",
    smooth: true,
    data: rows
      .filter((r) => r[key] !== null && r[key] !== undefined)
      .map((r) => [r.year, r[key]]),
    itemStyle: { color },
    lineStyle: { color },
  }));

  chart.setOption({
    xAxis: {
      type: "value", name: "year", scale: true,
      axisLabel: { formatter: (v) => Math.round(v) },
    },
    yAxis: {
      type: "value", name: "fraction", scale: true, min: 0, max: 1,
    },
    legend: { data: SERIES_DEF.map((s) => s.name) },
    dataZoom: [{ type: "inside" }],
    toolbox: RESET_ZOOM_TOOLBOX,
    tooltip: {
      trigger: "axis",
      valueFormatter: (v) => (typeof v === "number" ? v.toFixed(3) : v),
    },
    series,
  });

  return chart;
}
