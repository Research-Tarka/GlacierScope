import { freshChart, RESET_ZOOM_TOOLBOX } from "./chart_util.js";

const FEATURE_COLORS = {
  sgv: "#c9a300",
  snow: "#3b7fc9",
  ice: "#e07a2e",
};

// sgv_stack pixel classes: 0 other, 1 snow, 2 ice, 3 cloud-excluded,
// 4 outside the glacier footprint (never a real classification -- kept
// separate from cloud so real cloud-masked pixels aren't drowned out by
// the much larger area outside the glacier).
const CLASS_COLORS = ["#9a9a9a", "#3b7fc9", "#e07a2e", "#8e44ad", "#f2f2f2"];
const CLASS_LABELS = ["Other", "Snow", "Ice", "Cloud (excluded)", "Outside footprint"];

// The classic year-vs-area line chart -- unchanged from before, just
// renamed ("Area evolution") now that the 2D/3D spatial views below are
// their own separate charts instead of being folded into "2D"/"3D".
export function renderEvolutionTemporal(container, geomSeries) {
  const chart = freshChart(container);

  const years = [];
  const areasKm2 = [];
  const series = ["sgv", "snow", "ice"].map((featureType) => {
    const rows = geomSeries
      .filter((r) => r.feature_type === featureType)
      .sort((a, b) => a.year - b.year);
    for (const r of rows) {
      years.push(r.year);
      areasKm2.push(r.area_m2 / 1e6);
    }
    return {
      name: featureType,
      type: "line",
      smooth: true,
      data: rows.map((r) => [r.year, r.area_m2 / 1e6]),
      itemStyle: { color: FEATURE_COLORS[featureType] },
      lineStyle: { color: FEATURE_COLORS[featureType] },
    };
  });

  const yMin = areasKm2.length ? Math.min(...areasKm2) : 0;
  const yMax = areasKm2.length ? Math.max(...areasKm2) : 1;
  const yPad = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.1 || 1;

  chart.setOption({
    xAxis: {
      type: "value",
      name: "year",
      scale: true,
      min: years.length ? "dataMin" : undefined,
      max: years.length ? "dataMax" : undefined,
      axisLabel: { formatter: (v) => Math.round(v) },
    },
    yAxis: {
      type: "value",
      name: "area (km²)",
      scale: true,
      min: areasKm2.length ? yMin - yPad : undefined,
      max: areasKm2.length ? yMax + yPad : undefined,
      axisLabel: { formatter: (v) => v.toFixed(2) },
    },
    legend: { data: ["sgv", "snow", "ice"] },
    dataZoom: [{ type: "inside" }],
    toolbox: RESET_ZOOM_TOOLBOX,
    tooltip: {
      trigger: "axis",
      valueFormatter: (v) => (typeof v === "number" ? `${v.toFixed(3)} km²` : v),
    },
    series,
  });

  return chart;
}

// Pixel row/col used as the horizontal plane -- no per-pixel geographic
// transform is cached (only the DEM grid and glacier-level metadata), so
// this shows the surface shape and classification, not a georeferenced
// footprint.
function classPlaneForYear(sgvStack, yearIndex) {
  const { height, width, values: sgv } = sgvStack;
  const offset = yearIndex * height * width;
  const points = new Array(height * width);
  let i = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      points[i++] = [col, row, sgv[offset + row * width + col]];
    }
  }
  return points;
}

// All years' frames computed once up front instead of on each scrubber
// tick -- rebuilding a 193x193+ point array from scratch every time the
// slider moves is what made scrubbing feel like it was "loading" each
// step instead of playing smoothly; precomputing trades a bit of startup
// time for the scrubber/play button being instant afterward.
function precomputeFrames(sgvStack, frameFn) {
  const frames = new Array(sgvStack.n_years);
  for (let i = 0; i < sgvStack.n_years; i++) frames[i] = frameFn(sgvStack, i);
  return frames;
}

// The glacier's snow/ice/other footprint shape at each year, in (col, row)
// space -- a flat heatmap-style view of what area_m2 in the temporal chart
// above is summarizing, so the shape itself (not just its total) can be
// seen changing year to year via the scrubber.
export function renderEvolutionSpatial2D(container, sgvStack) {
  const chart = freshChart(container);
  const { years, height, width } = sgvStack;
  const frames = precomputeFrames(sgvStack, classPlaneForYear);

  const colLabels = Array.from({ length: width }, (_, i) => String(i));
  const rowLabels = Array.from({ length: height }, (_, i) => String(i));

  const option = {
    xAxis: { type: "category", data: colLabels, show: false },
    yAxis: { type: "category", data: rowLabels, show: false, inverse: true },
    dataZoom: [{ type: "inside" }, { type: "inside", yAxisIndex: 0 }],
    toolbox: RESET_ZOOM_TOOLBOX,
    visualMap: {
      show: true,
      type: "piecewise",
      seriesIndex: 0,
      dimension: 2,
      orient: "horizontal",
      left: "center",
      bottom: 10,
      min: 0,
      max: 4,
      pieces: CLASS_LABELS.map((label, value) => ({ value, label, color: CLASS_COLORS[value] })),
    },
    tooltip: {
      formatter: (p) => `${CLASS_LABELS[p.data[2]] || p.data[2]}<br/>X ${p.data[0]}, Y ${p.data[1]}`,
    },
    series: [{
      type: "heatmap",
      data: frames[0],
      itemStyle: { borderWidth: 0 },
      progressive: 4000,
      animation: false,
    }],
  };
  chart.setOption(option);

  function setYear(yearIndex) {
    chart.setOption({ series: [{ data: frames[yearIndex] }] });
  }

  return { chart, years, setYear };
}

// Draped on the DEM's actual relief: a plain gray terrain surface always
// covering the full extent (so the ground beyond the glacier is visible
// too), plus one translucent colored surface per class (snow/ice/other)
// showing only that year's pixels of that class, at the same elevation as
// the terrain beneath them. This replaces an earlier single 4-dimension
// surface (col, row, z, class) with a piecewise visualMap on the class
// dimension -- that combination is what appears to make echarts-gl fail to
// render anything (a blank chart, no grid, no error) whenever the surface
// series data carries 4 dimensions with a piecewise visualMap bound to the
// 4th. Splitting color-by-class out into separate flat-colored surfaces
// (matching centroid.js's already-working "glacier extent" overlay
// pattern, which never hit that failure mode) sidesteps it entirely.
export function renderEvolutionSpatial3D(container, dem, sgvStack) {
  const chart = freshChart(container);
  const { years, height, width } = sgvStack;
  const hasDem = !!dem;

  if (hasDem && (dem.height !== height || dem.width !== width)) {
    container.textContent = "DEM and classification grid size mismatch.";
    return { chart, years: [], setYear: () => {} };
  }

  const heights = hasDem ? dem.values : null;
  let zMin = 0;
  let zMax = 1;
  if (hasDem) {
    zMin = Infinity;
    zMax = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      if (Number.isNaN(heights[i])) continue;
      if (heights[i] < zMin) zMin = heights[i];
      if (heights[i] > zMax) zMax = heights[i];
    }
    if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMin === zMax) {
      zMin = 0;
      zMax = 1;
    }
  }
  const fallbackZ = zMin;

  // NaN DEM pixels (real gaps -- outside the raster's actual coverage, or
  // nodata) are pushed as null, not flattened to the glacier's own zMin:
  // filling them in made the flat "background" area stretch out at the
  // glacier's lowest real elevation, reading as an oversized flat table
  // extending far past the actual terrain instead of the terrain's real
  // (uneven) edge. echarts-gl's surface series skips null z values, same
  // as centroid.js's DEM surface already does.
  function terrainSurface() {
    const data = new Array(height * width);
    let i = 0;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const rawZ = hasDem ? heights[row * width + col] : 0;
        data[i++] = [col, row, Number.isNaN(rawZ) ? null : rawZ];
      }
    }
    return data;
  }

  // One surface per class, per year -- kept as 4 separate toggleable
  // series (rather than 1 merged surface) specifically so each class has
  // its own legend entry that can be shown/hidden independently.
  //
  // echarts-gl's surface series only draws the quad face between two grid
  // points when BOTH are non-null -- so a class surface built from an
  // exact "cls === c" mask never draws the face straddling a class
  // boundary (one corner is this class, the other is null for it), which
  // reads as a permanent 1-pixel gap seam everywhere two classes meet.
  // Fix: dilate each class's mask by its immediate 4-neighbors before
  // building the surface, so adjacent class surfaces overlap by one row/
  // column of quads at every boundary instead of both stopping short of
  // it -- trading the gap for a 1-pixel-wide overlap between the two
  // colors, which a small per-class z-nudge below then makes deterministic
  // (higher-priority class wins) instead of flickering.
  function classSurfacesForYear(sgvStackArg, yearIndex) {
    const { values: sgv } = sgvStackArg;
    const offset = yearIndex * height * width;
    const classAt = (row, col) => sgv[offset + row * width + col];
    // index 0=other, 1=snow, 2=ice, 3=cloud (excluded)
    const perClass = [
      new Array(height * width),
      new Array(height * width),
      new Array(height * width),
      new Array(height * width),
    ];
    // The dilated border pixel is defined at the SAME (x, y, z) in both of
    // the two surfaces that share it, so without any nudge the GPU has to
    // arbitrarily pick which coplanar face wins each frame (z-fighting --
    // a flickering/patchy mix of both colors right on the boundary line).
    // Nudging every non-owning (dilated-in) copy up by a tiny amount, more
    // for higher-priority classes, makes the higher-priority surface
    // consistently win that shared edge -- matching the same
    // other<snow<ice<cloud priority serve.py already paints overlaps with
    // -- instead of flickering between the two.
    const Z_EPS = ((zMax - zMin) || 1) * 1e-4;

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cls = classAt(row, col);
        const rawZ = hasDem ? heights[idx] : 0;
        const z = Number.isNaN(rawZ) ? fallbackZ : rawZ;
        // Bitmask over the 4 classes (bit c set = present among this pixel
        // and its 4-neighbors) -- avoids a Set allocation per pixel in
        // this hot, precomputed-per-year loop.
        let neighborMask = 1 << cls;
        if (row > 0) neighborMask |= 1 << classAt(row - 1, col);
        if (row < height - 1) neighborMask |= 1 << classAt(row + 1, col);
        if (col > 0) neighborMask |= 1 << classAt(row, col - 1);
        if (col < width - 1) neighborMask |= 1 << classAt(row, col + 1);
        for (const c of [0, 1, 2, 3]) {
          if (!(neighborMask & (1 << c))) {
            perClass[c][idx] = [col, row, null];
            continue;
          }
          perClass[c][idx] = [col, row, c === cls ? z : z + c * Z_EPS];
        }
      }
    }
    return perClass;
  }

  const frames = precomputeFrames(sgvStack, classSurfacesForYear);

  const option = {
    grid3D: {
      viewControl: { zoomSensitivity: 5 },
      axisLabel: { show: true },
      axisLine: { show: true },
      boxHeight: 60,
    },
    xAxis3D: { type: "value", name: "X" },
    yAxis3D: { type: "value", name: "Y" },
    zAxis3D: {
      type: "value",
      name: hasDem ? "elevation (m)" : "elevation (n/a)",
      min: zMin,
      max: zMax,
      axisLabel: { formatter: (v) => Math.round(v) },
    },
    tooltip: {
      formatter: (p) => {
        const z = hasDem ? `${p.data[2].toFixed(0)} m` : "n/a";
        return `${p.seriesName}<br/>X ${p.data[0]}, Y ${p.data[1]}<br/>elevation: ${z}`;
      },
    },
    // Outside-footprint pixels aren't drawn here -- as a surface they'd
    // just be a giant patch covering the whole exterior, adding no
    // information beyond what the terrain mesh already shows -- so the
    // legend only lists the four real classes, not CLASS_LABELS[4].
    legend: { data: ["terrain", ...CLASS_LABELS.slice(0, 4)], bottom: 0 },
    series: [
      {
        name: "terrain",
        type: "surface",
        wireframe: { show: false },
        itemStyle: { color: "#c9c9c9", opacity: 0.85, borderWidth: 0 },
        shading: "lambert",
        silent: true,
        data: terrainSurface(),
        animation: false,
      },
      {
        name: CLASS_LABELS[0],
        type: "surface",
        wireframe: { show: false },
        itemStyle: { color: CLASS_COLORS[0], opacity: 0.85, borderWidth: 0 },
        shading: "color",
        data: frames[0][0],
        animation: false,
      },
      {
        name: CLASS_LABELS[1],
        type: "surface",
        wireframe: { show: false },
        itemStyle: { color: CLASS_COLORS[1], opacity: 0.85, borderWidth: 0 },
        shading: "color",
        data: frames[0][1],
        animation: false,
      },
      {
        name: CLASS_LABELS[2],
        type: "surface",
        wireframe: { show: false },
        itemStyle: { color: CLASS_COLORS[2], opacity: 0.85, borderWidth: 0 },
        shading: "color",
        data: frames[0][2],
        animation: false,
      },
      {
        name: CLASS_LABELS[3],
        type: "surface",
        wireframe: { show: false },
        itemStyle: { color: CLASS_COLORS[3], opacity: 0.85, borderWidth: 0 },
        shading: "color",
        data: frames[0][3],
        animation: false,
      },
    ],
  };
  if (!hasDem) {
    option.title = {
      text: "No DEM for this glacier -- showing classification on a flat plane (elevation unavailable in the source data)",
      top: 0,
      left: "center",
      textStyle: { fontSize: 11, color: "#a06a00", fontWeight: "normal" },
    };
  }

  chart.setOption(option);

  function setYear(yearIndex) {
    const perClass = frames[yearIndex];
    chart.setOption({
      series: [{}, { data: perClass[0] }, { data: perClass[1] }, { data: perClass[2] }, { data: perClass[3] }],
    });
  }

  return { chart, years, setYear };
}
