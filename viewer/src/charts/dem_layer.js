// Shared DEM-as-raster layer for 2D echarts charts (reference footprint,
// centroid drift 2D): every pixel gets its own heatmap cell -- not a
// scatter of sampled points with gaps between them -- on category axes,
// with a second value-axis pair on the same grid so points/lines can be
// overlaid on top in continuous (col, row) space. Dark = high elevation,
// light = low, matching how elevation is read on a real hillshaded map;
// the color scale's legend shows the actual min/max values (not "high"/
// "low" placeholders), and the layer is toggle-able from the chart legend
// since it's a normal named series.
export function buildDemHeatmapLayer(dem) {
  const { height, width, values } = dem;
  const cells = [];
  let demMin = Infinity;
  let demMax = -Infinity;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const z = values[row * width + col];
      if (Number.isNaN(z)) continue;
      cells.push([col, row, z]);
      if (z < demMin) demMin = z;
      if (z > demMax) demMax = z;
    }
  }
  if (!Number.isFinite(demMin)) demMin = 0;
  if (!Number.isFinite(demMax)) demMax = 1;

  const colLabels = Array.from({ length: width }, (_, i) => String(i));
  const rowLabels = Array.from({ length: height }, (_, i) => String(i));

  return {
    xAxisCategory: { type: "category", data: colLabels, show: false, gridIndex: 0 },
    yAxisCategory: { type: "category", data: rowLabels, show: false, inverse: true, gridIndex: 0 },
    xAxisValue: { type: "value", name: "X", min: 0, max: width, gridIndex: 0 },
    yAxisValue: { type: "value", name: "Y", min: 0, max: height, inverse: true, gridIndex: 0 },
    series: {
      name: "elevation",
      type: "heatmap",
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: cells,
      itemStyle: { borderWidth: 0 },
      progressive: 4000,
      tooltip: { formatter: (p) => `elevation ${p.data[2].toFixed(0)} m` },
    },
    visualMap: {
      seriesIndex: 0,
      min: demMin,
      max: demMax,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 10,
      inRange: { color: ["#eeeeee", "#242424"] },
      formatter: (v) => `${Math.round(v)} m`,
    },
  };
}
