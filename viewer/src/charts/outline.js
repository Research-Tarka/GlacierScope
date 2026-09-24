import { buildDemHeatmapLayer } from "./dem_layer.js";
import { freshChart, RESET_ZOOM_TOOLBOX } from "./chart_util.js";

function ringToPoints(ring) {
  return ring.map(([x, y]) => [x, y]);
}

// Each polygon's first ring is its exterior boundary (filled); any further
// rings are holes (not filled). A glacier can be a MultiPolygon (several
// disconnected fragments) -- every fragment's exterior needs its own fill,
// not just the first one, or fragmented glaciers render mostly empty.
export function extractRings(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const rings = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, i) => {
      rings.push({ points: ringToPoints(ring), isExterior: i === 0 });
    });
  }
  return rings;
}

function fallbackTitle(isFallback) {
  if (!isFallback) return undefined;
  return {
    text: "No sgv_ref for this glacier -- showing the most recent sgv/ice/snow footprint instead",
    top: 0,
    left: "center",
    textStyle: { fontSize: 11, color: "#a06a00", fontWeight: "normal" },
  };
}

export function renderOutline(container, outline, dem, outlinePixel) {
  const chart = freshChart(container);
  const usePixel = !!(dem && outlinePixel);
  const rings = extractRings(usePixel ? outlinePixel.geometry : outline.geometry);
  const isFallback = !!outline.properties?.is_fallback;
  const title = fallbackTitle(isFallback);

  if (usePixel) {
    const dem2d = buildDemHeatmapLayer(dem);
    const series = [dem2d.series];
    series.push(
      ...rings.map(({ points, isExterior }) => ({
        name: "footprint",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points,
        showSymbol: false,
        areaStyle: isExterior ? { color: "#ffffff", opacity: 0.08 } : undefined,
        lineStyle: { color: "#c0392b", width: 2 },
        z: 5,
        silent: true,
        tooltip: { show: false },
      }))
    );

    const options = {
      xAxis: [dem2d.xAxisCategory, dem2d.xAxisValue],
      yAxis: [dem2d.yAxisCategory, dem2d.yAxisValue],
      legend: { data: ["elevation"], selected: { elevation: true } },
      dataZoom: [{ type: "inside", xAxisIndex: [0, 1] }, { type: "inside", yAxisIndex: [0, 1] }],
      toolbox: RESET_ZOOM_TOOLBOX,
      visualMap: dem2d.visualMap,
      series,
    };
    if (title) options.title = title;
    chart.setOption(options);
    return chart;
  }

  const series = rings.map(({ points, isExterior }) => ({
    name: "footprint",
    type: "line",
    data: points,
    showSymbol: false,
    areaStyle: isExterior ? { color: "#bcd9f7" } : undefined,
    lineStyle: { color: "#2a6fb0" },
    tooltip: { show: false },
  }));

  const options = {
    xAxis: { type: "value", scale: true, name: "lon" },
    yAxis: { type: "value", scale: true, name: "lat" },
    dataZoom: [{ type: "inside" }],
    toolbox: RESET_ZOOM_TOOLBOX,
    series,
    tooltip: { show: false },
  };
  if (title) options.title = title;
  chart.setOption(options);

  return chart;
}
