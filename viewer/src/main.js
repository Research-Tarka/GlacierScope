import { initMap, setSelectedOutline } from "./map.js";
import { initSearch } from "./search.js";
import { onGlacierSelected } from "./state.js";
import { addDownloadButtons, SINGLE_SHEET } from "./download.js";
import {
  loadIndex,
  loadSources,
  loadMeta,
  loadYearSeries,
  loadGeomSeries,
  loadOutline,
  loadOutlinePixel,
  loadChangeHeatmap,
  loadDem,
  loadDemFull,
  loadSgvStack,
  loadAltitudeEvolution,
} from "./data.js";
import { renderOutline } from "./charts/outline.js";
import { renderCentroid2D, renderCentroid3D } from "./charts/centroid.js";
import { renderEvolutionTemporal, renderEvolutionSpatial2D, renderEvolutionSpatial3D } from "./charts/evolution.js";
import { renderAltitudeEvolution } from "./charts/altitude_evolution.js";
import { renderFractionEvolution } from "./charts/fraction.js";
import { renderHeatmap } from "./charts/heatmap.js";
import { renderVariableBrowser } from "./variables.js";
import {
  outlineCsv,
  centroidCsv,
  evolutionTemporalCsv,
  evolutionSpatialCsv,
  fractionEvolutionCsv,
  altitudeEvolutionCsv,
  changeHeatmapCsv,
} from "./charts/csv_export.js";

const detailSection = document.getElementById("detail");
const detailTitle = document.getElementById("detail-title");

let activeCharts = [];
let disposeVariableCharts = () => {};
let stopScrubbers = [];

function disposeActiveCharts() {
  for (const chart of activeCharts) chart.dispose();
  activeCharts = [];
  disposeVariableCharts();
  disposeVariableCharts = () => {};
  for (const stop of stopScrubbers) stop();
  stopScrubbers = [];
}

// Drives a chart's year by hand instead of echarts' timeline component
// (see charts/evolution.js) -- these sliders are both the requested
// scrubber UI and the mechanism that sidesteps the internal echarts-gl
// crash the timeline component triggered on frame switches.
function wireYearScrubber(prefix, years, setYear) {
  const slider = document.getElementById(`${prefix}-slider`);
  const play = document.getElementById(`${prefix}-play`);
  const year = document.getElementById(`${prefix}-year`);
  if (!years.length) {
    slider.max = 0;
    slider.value = 0;
    year.textContent = "";
    play.disabled = true;
    return () => {};
  }

  play.disabled = false;
  slider.max = String(years.length - 1);
  slider.value = String(years.length - 1);
  year.textContent = String(years[years.length - 1]);

  const applyIndex = (i) => {
    setYear(i);
    year.textContent = String(years[i]);
  };

  const onSlide = () => applyIndex(Number(slider.value));
  slider.addEventListener("input", onSlide);

  let timer = null;
  const stopPlaying = () => {
    if (timer) clearInterval(timer);
    timer = null;
    play.textContent = "Play";
  };
  const startPlaying = () => {
    let i = Number(slider.value);
    timer = setInterval(() => {
      i = (i + 1) % years.length;
      slider.value = String(i);
      applyIndex(i);
    }, 900);
    play.textContent = "Pause";
  };
  const onPlayClick = () => (timer ? stopPlaying() : startPlaying());
  play.addEventListener("click", onPlayClick);

  return () => {
    stopPlaying();
    slider.removeEventListener("input", onSlide);
    play.removeEventListener("click", onPlayClick);
  };
}

function wireDownloads(elementId, chart, name, csvSheetNames, getCsvSpec) {
  const chartEl = document.getElementById(elementId);
  const box = chartEl.closest(".figure-box");
  const row = box.querySelector(".download-row");
  addDownloadButtons(row, chart, name, csvSheetNames, getCsvSpec);
  activeCharts.push(chart);

  // Watches the chart's own container box, not just the expand toggle --
  // a single deferred resize() call after the class toggle was still
  // liable to race the browser's actual layout pass (position:fixed +
  // flex reflow isn't guaranteed done by the next animation frame on
  // every browser/machine). ResizeObserver fires whenever the box's real
  // size changes for any reason, expand/collapse included, so the chart
  // is always resized to match reality instead of a best-guess timing.
  const resizeObserver = new ResizeObserver(() => chart.resize());
  resizeObserver.observe(chartEl);
  chart.on("dispose", () => resizeObserver.disconnect());

  if (!box.querySelector(".expand-toggle")) {
    const toggle = document.createElement("button");
    toggle.className = "expand-toggle";
    toggle.textContent = "Expand";
    toggle.addEventListener("click", () => {
      box.classList.toggle("expanded");
      toggle.textContent = box.classList.contains("expanded") ? "Collapse" : "Expand";
    });
    box.appendChild(toggle);
  }
}

function showError(elementId, err) {
  console.error(elementId, err);
  document.getElementById(elementId).textContent = `Could not render: ${err.message || err}`;
}

async function showGlacier(idGlims) {
  detailSection.classList.remove("hidden");
  detailTitle.textContent = idGlims;
  disposeActiveCharts();
  setSelectedOutline(null);

  // Every per-glacier resource is independent of the others (server-side
  // they're separate cached lookups) -- fetching them all at once instead
  // of one after another turns N sequential round trips into the time of
  // the single slowest one. Each chart still renders as soon as its own
  // data lands (nothing waits on the whole batch), so charts appear in
  // whatever order their fetch actually finishes.
  const [
    geomSeriesResult,
    demResult,
    demFullResult,
    sgvStackResult,
    outlinePixelResult,
    outlineResult,
    yearSeriesResult,
    metaResult,
    sourcesResult,
    heatmapResult,
    altitudeEvolutionResult,
  ] = await Promise.allSettled([
    loadGeomSeries(idGlims),
    loadDem(idGlims),
    loadDemFull(idGlims),
    loadSgvStack(idGlims),
    loadOutlinePixel(idGlims),
    loadOutline(idGlims),
    loadYearSeries(idGlims),
    loadMeta(idGlims),
    loadSources(),
    loadChangeHeatmap(idGlims),
    loadAltitudeEvolution(idGlims),
  ]);

  const geomSeries = geomSeriesResult.status === "fulfilled" ? geomSeriesResult.value : [];
  if (geomSeriesResult.status === "rejected") console.error("geom_series", geomSeriesResult.reason);

  const dem = demResult.status === "fulfilled" ? demResult.value : null;
  if (demResult.status === "rejected") console.warn(`no DEM for ${idGlims}`, demResult.reason);

  const demFull = demFullResult.status === "fulfilled" ? demFullResult.value : null;
  if (demFullResult.status === "rejected") console.warn(`no full-extent DEM for ${idGlims}`, demFullResult.reason);

  const sgvStack = sgvStackResult.status === "fulfilled" ? sgvStackResult.value : null;
  if (sgvStackResult.status === "rejected") console.warn(`no classification stack for ${idGlims}`, sgvStackResult.reason);

  // No CRS/transform for this glacier -- outline/heatmap fall back to no footprint overlay.
  const outlinePixel = outlinePixelResult.status === "fulfilled" ? outlinePixelResult.value : null;

  if (outlineResult.status === "fulfilled") {
    try {
      setSelectedOutline(outlineResult.value);
      wireDownloads(
        "chart-outline",
        renderOutline(document.getElementById("chart-outline"), outlineResult.value, dem, outlinePixel),
        `${idGlims}_outline`,
        SINGLE_SHEET, () => outlineCsv(outlineResult.value)
      );
    } catch (err) {
      showError("chart-outline", err);
    }
  } else {
    showError("chart-outline", outlineResult.reason);
  }

  wireDownloads(
    "chart-centroid-2d",
    renderCentroid2D(document.getElementById("chart-centroid-2d"), geomSeries, demFull, outlinePixel),
    `${idGlims}_centroid_2d`,
    SINGLE_SHEET, () => centroidCsv(geomSeries)
  );
  wireDownloads(
    "chart-centroid-3d",
    renderCentroid3D(document.getElementById("chart-centroid-3d"), geomSeries, demFull, outlinePixel),
    `${idGlims}_centroid_3d`,
    SINGLE_SHEET, () => centroidCsv(geomSeries)
  );
  wireDownloads(
    "chart-evolution-temporal",
    renderEvolutionTemporal(document.getElementById("chart-evolution-temporal"), geomSeries),
    `${idGlims}_evolution_temporal`,
    SINGLE_SHEET, () => evolutionTemporalCsv(geomSeries)
  );

  try {
    if (!sgvStack) throw new Error("no classification stack for this glacier");
    const { chart, years, setYear } = renderEvolutionSpatial2D(
      document.getElementById("chart-evolution-2d"), sgvStack
    );
    wireDownloads(
      "chart-evolution-2d", chart, `${idGlims}_evolution_2d`,
      SINGLE_SHEET, () => evolutionSpatialCsv(sgvStack)
    );
    stopScrubbers.push(wireYearScrubber("evolution-2d", years, setYear));
  } catch (err) {
    showError("chart-evolution-2d", err);
  }

  try {
    if (!sgvStack) throw new Error("no classification stack for this glacier");
    const { chart, years, setYear } = renderEvolutionSpatial3D(
      document.getElementById("chart-evolution-3d"), demFull, sgvStack
    );
    wireDownloads(
      "chart-evolution-3d", chart, `${idGlims}_evolution_3d`,
      SINGLE_SHEET, () => evolutionSpatialCsv(sgvStack)
    );
    stopScrubbers.push(wireYearScrubber("evolution-3d", years, setYear));
  } catch (err) {
    showError("chart-evolution-3d", err);
  }

  const yearSeries = yearSeriesResult.status === "fulfilled" ? yearSeriesResult.value : {};
  if (yearSeriesResult.status === "fulfilled") {
    try {
      wireDownloads(
        "chart-fraction-evolution",
        renderFractionEvolution(document.getElementById("chart-fraction-evolution"), yearSeries),
        `${idGlims}_fraction_evolution`,
        SINGLE_SHEET, () => fractionEvolutionCsv(yearSeries)
      );
    } catch (err) {
      showError("chart-fraction-evolution", err);
    }
  } else {
    showError("chart-fraction-evolution", yearSeriesResult.reason);
  }

  if (altitudeEvolutionResult.status === "fulfilled") {
    try {
      wireDownloads(
        "chart-altitude-evolution",
        renderAltitudeEvolution(document.getElementById("chart-altitude-evolution"), altitudeEvolutionResult.value),
        `${idGlims}_altitude_evolution`,
        ["pixel_groups", "tsl"], () => altitudeEvolutionCsv(altitudeEvolutionResult.value)
      );
    } catch (err) {
      showError("chart-altitude-evolution", err);
    }
  } else {
    showError("chart-altitude-evolution", altitudeEvolutionResult.reason);
  }

  if (heatmapResult.status === "fulfilled") {
    try {
      wireDownloads(
        "chart-heatmap",
        renderHeatmap(document.getElementById("chart-heatmap"), heatmapResult.value, outlinePixel),
        `${idGlims}_change_heatmap`,
        SINGLE_SHEET, () => changeHeatmapCsv(heatmapResult.value)
      );
    } catch (err) {
      showError("chart-heatmap", err);
    }
  } else {
    showError("chart-heatmap", heatmapResult.reason);
  }

  if (metaResult.status === "fulfilled" && sourcesResult.status === "fulfilled") {
    try {
      disposeVariableCharts = renderVariableBrowser(
        document.getElementById("variable-browser"), idGlims, metaResult.value, yearSeries, sourcesResult.value
      );
    } catch (err) {
      console.error("variable-browser", err);
      document.getElementById("variable-browser").textContent = `Could not load variables: ${err.message || err}`;
    }
  } else {
    const err = metaResult.status === "rejected" ? metaResult.reason : sourcesResult.reason;
    console.error("variable-browser", err);
    document.getElementById("variable-browser").textContent = `Could not load variables: ${err.message || err}`;
  }
}

async function main() {
  const indexRows = await loadIndex();
  initMap(indexRows);
  initSearch(indexRows);
  onGlacierSelected(showGlacier);
}

main();
