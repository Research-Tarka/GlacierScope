import { freshChart, RESET_ZOOM_TOOLBOX } from "./chart_util.js";

// Reproduces the reference pipeline's "fragmentation spatiale et dynamique
// altitudinale" chart (Scripts/05_Accumulation_Ablation.py ->
// Utils/accum_ablation_engine.py's PixelGroup construction, rendered by
// Visualize/09_Visualizer.py::_npz_to_tree_plotly_html): one point per
// *connected component* of same-class pixels per year (not one mean per
// class per year), sized by pixel count and colored along a gradient by
// pixel-count fraction, split into accumulation (snow) vs ablation (ice).
//
// The connected-components/TSL computation itself (8-connectivity groups,
// snow/ice contact frontier) runs server-side now (serve.py's
// load_altitude_evolution, via scipy.ndimage.label) instead of a hand-rolled
// JS flood fill here -- same algorithm, but vectorized and cached to disk
// per glacier instead of recomputed in every browser tab that opens this
// chart. This module only renders the precomputed result.

export function renderAltitudeEvolution(container, altitudeEvolution) {
  const chart = freshChart(container);

  if (!altitudeEvolution) {
    container.textContent = "No DEM/classification data available for this glacier to compute altitude evolution.";
    return chart;
  }

  const { accumulation, ablation, tsl, sgv_ref_max_elevation: sgvMax } = altitudeEvolution;
  if (!accumulation.length && !ablation.length) {
    container.textContent = "No snow/ice pixel groups found across the classification stack for this glacier.";
    return chart;
  }

  // Color shows pixel count, one gradient per class -- kept. Two things
  // fixed here: (1) each class's gradient is now scaled to that class's
  // OWN min/max pixel count (relative/local), not a single max shared
  // between snow and ice -- sharing one scale meant whichever class had
  // fewer pixels overall never reached the dark end of its own bar, even
  // for its biggest groups; (2) the top legend's swatches now use the
  // dark (high) end of each series' own gradient instead of an unrelated
  // flat color, so they visually match the gradient bars below instead of
  // looking like a disconnected second color scheme.
  // High-contrast, saturated endpoints (not pastel-to-dark-of-the-same-hue)
  // so the gradient's variation actually reads at a glance instead of
  // blurring into one washed-out color across most of the range.
  const SNOW_GRADIENT = ["#00e5ff", "#1a237e"];
  const ICE_GRADIENT = ["#ffee00", "#b71c1c"];

  const series = [];
  const seriesGradients = [];
  for (const [bucket, symbol, name, gradient] of [
    [accumulation, "circle", "Snow", SNOW_GRADIENT],
    [ablation, "triangle", "Ice", ICE_GRADIENT],
  ]) {
    if (!bucket.length) continue;
    seriesGradients.push({ seriesIndex: series.length, name, gradient, max: Math.max(1, ...bucket.map((p) => p.pixelCount)) });
    series.push({
      name,
      type: "scatter",
      data: bucket.map((p) => [p.year, p.mean, p.pixelCount, p.min, p.max]),
      symbol,
      symbolSize: 12,
    });
  }

  if (tsl.length) {
    series.push({
      name: "TSL proxy (snow/ice contact line)",
      type: "line",
      data: tsl,
      showSymbol: false,
      lineStyle: { color: "#00c853", width: 2, type: "dashed" },
    });
  }

  if (sgvMax != null && series.length) {
    series[0].markLine = {
      silent: true,
      symbol: "none",
      lineStyle: { color: "#455a64", width: 1.8, type: "dotted" },
      label: { formatter: `Max SGV altitude: ${Math.round(sgvMax)} m`, position: "insideEndTop" },
      data: [{ yAxis: sgvMax, name: "Max SGV altitude" }],
    };
  }

  const finite = (arr) => arr.filter((v) => Number.isFinite(v));
  const allYears = finite(
    [...accumulation, ...ablation].map((p) => p.year).concat(tsl.map((p) => p[0]))
  );
  const allElevs = finite(
    [...accumulation, ...ablation].map((p) => p.mean).concat(tsl.map((p) => p[1]), sgvMax != null ? [sgvMax] : [])
  );
  const yPad = allElevs.length ? (Math.max(...allElevs) - Math.min(...allElevs)) * 0.05 || 10 : 10;

  chart.setOption({
    xAxis: {
      type: "value", name: "year", scale: true, nameGap: 25,
      min: allYears.length ? Math.min(...allYears) : undefined,
      max: allYears.length ? Math.max(...allYears) : undefined,
      axisLabel: { formatter: (v) => Math.round(v) },
    },
    yAxis: {
      type: "value", name: "elevation (m)", scale: true,
      min: allElevs.length ? Math.min(...allElevs) - yPad : undefined,
      max: allElevs.length ? Math.max(...allElevs) + yPad : undefined,
      axisLabel: { formatter: (v) => Math.round(v) },
    },
    legend: {
      top: 0,
      data: series.map((s) => {
        const g = seriesGradients.find((sg) => sg.name === s.name);
        return g ? { name: s.name, icon: s.symbol, itemStyle: { color: g.gradient[1] } } : { name: s.name };
      }),
    },
    // Stacked one above the other (not side by side) below the plot, and
    // each on its own min/max scale (that class's own biggest group), not
    // a scale shared between snow and ice -- whichever class had fewer
    // pixels overall never reached the dark end of a shared scale even
    // for its own largest groups.
    //
    // echarts' continuous visualMap takes itemWidth as the bar's
    // THICKNESS and itemHeight as its LENGTH when orient is horizontal
    // (the reverse of what those names suggest) -- swapping them is what
    // was rendering as a tall vertical pill instead of a wide horizontal
    // bar despite orient: "horizontal" being set correctly.
    grid: { top: 60, bottom: 115, left: 60, right: 20 },
    visualMap: seriesGradients.map(({ seriesIndex, name, gradient, max }, i) => ({
      seriesIndex,
      dimension: 2,
      min: 0,
      max,
      orient: "horizontal",
      left: "center",
      bottom: i === 0 ? 45 : 6,
      itemWidth: 12,
      itemHeight: 160,
      text: [`${name}: more px`, `${name}: fewer px`],
      calculable: true,
      inRange: { color: gradient },
      formatter: (v) => `${Math.round(v)} px`,
    })),
    dataZoom: [
      { type: "inside", xAxisIndex: 0 },
      { type: "inside", yAxisIndex: 0 },
    ],
    toolbox: RESET_ZOOM_TOOLBOX,
    tooltip: {
      formatter: (p) =>
        Array.isArray(p.data) && p.data.length >= 3
          ? `${p.marker || ""}${p.seriesName}, year ${p.data[0]}<br/>mean elevation ${p.data[1].toFixed(0)} m<br/>${p.data[2]} px (min ${p.data[3].toFixed(0)} m, max ${p.data[4].toFixed(0)} m)`
          : `${p.marker || ""}${p.seriesName}, year ${p.data[0]}<br/>${p.data[1].toFixed(0)} m`,
    },
    series,
  });

  return chart;
}
