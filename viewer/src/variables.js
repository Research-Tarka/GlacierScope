import { addDownloadButtons, SINGLE_SHEET } from "./download.js";

const CATEGORY_LABELS = {
  glacier: "Glacier",
  climate: "Climate",
};

function toCsv(rows, columns) {
  const header = columns.join(",");
  const lines = rows.map((row) =>
    columns.map((col) => {
      const v = row[col];
      if (v === null || v === undefined) return "";
      const s = String(v);
      return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  );
  return [header, ...lines].join("\n");
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Which variables were checked, kept across glacier switches and app
// restarts (not per-glacier -- the whole point is picking a set of
// variables once and having every subsequent glacier open with the same
// ones already selected, instead of re-checking boxes every time).
const SELECTION_STORAGE_KEY = "glacierscope.selectedVariables";

function loadStoredSelection() {
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveSelection(selected) {
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify([...selected]));
  } catch {
    // Storage unavailable (private browsing, quota) -- selection just
    // won't persist this session, not worth failing the picker over.
  }
}

// clim_* columns hold a single constant "climatology normal" value for a
// glacier (same value repeated on every year row, everything else null),
// not an actual per-year series -- charting them as a line is a flat
// line with one real point, which reads as broken rather than as what it
// is: one fact about the glacier. Always show these as a KPI instead.
function isClimatology(col) {
  return col.startsWith("clim_");
}

// Whether this column has at least one non-null value for the current
// glacier, across every row available (static: the one meta record;
// temporal: every year). Drives both the availability dot next to each
// checkbox and the "only show variables with data" filter -- a column
// can exist in the source table yet be entirely null for this specific
// glacier (missing coverage), which the picker otherwise gives no hint
// about before you actually select it.
function hasData(kind, sourceName, col, meta, yearSeries) {
  if (kind === "static") {
    const v = (meta[sourceName] || {})[col];
    return v !== null && v !== undefined;
  }
  const rows = yearSeries[sourceName] || [];
  return rows.some((r) => r[col] !== null && r[col] !== undefined);
}

// selected: Set of "sourceName::column" keys.
export function renderVariableBrowser(root, idGlims, meta, yearSeries, sources) {
  root.innerHTML = "";

  const byCategory = {};
  for (const [sourceName, info] of Object.entries(sources)) {
    const category = info.category || "glacier";
    (byCategory[category] = byCategory[category] || []).push({ sourceName, kind: info.kind });
  }

  const selected = loadStoredSelection();

  const searchWrap = document.createElement("div");
  searchWrap.className = "variable-search-wrap";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "variable-search";
  searchInput.placeholder = "Filter by variable or table name (e.g. \"area\", \"temperature\")...";
  searchWrap.appendChild(searchInput);

  const dataOnlyLabel = document.createElement("label");
  dataOnlyLabel.className = "variable-data-filter";
  const dataOnlyBox = document.createElement("input");
  dataOnlyBox.type = "checkbox";
  dataOnlyLabel.appendChild(dataOnlyBox);
  dataOnlyLabel.appendChild(document.createTextNode(` Only show variables with data for ${idGlims}`));
  searchWrap.appendChild(dataOnlyLabel);

  // Lets a large picker be collapsed down to just what's already checked --
  // the point is to make deselecting a few variables out of a big active
  // set easy, without having to hunt each one down through every category/
  // table section again.
  const selectedOnlyLabel = document.createElement("label");
  selectedOnlyLabel.className = "variable-data-filter";
  const selectedOnlyBox = document.createElement("input");
  selectedOnlyBox.type = "checkbox";
  selectedOnlyLabel.appendChild(selectedOnlyBox);
  selectedOnlyLabel.appendChild(document.createTextNode(" Only show selected variables"));
  searchWrap.appendChild(selectedOnlyLabel);
  root.appendChild(searchWrap);

  const picker = document.createElement("div");
  picker.className = "variable-picker";

  // Tracked so the search box above can filter the picker live instead of
  // requiring a second lookup UI -- typing a variable name hides everything
  // that doesn't match it, table filters included.
  const filterEntries = []; // { label, sourceBox, col, sourceName, hasData }
  const sourceBoxes = []; // { box, labels: [label, ...] }

  for (const [category, entries] of Object.entries(byCategory)) {
    const categoryBox = document.createElement("fieldset");
    categoryBox.className = "category-box";
    const legend = document.createElement("legend");
    legend.textContent = CATEGORY_LABELS[category] || category;
    categoryBox.appendChild(legend);

    for (const { sourceName, kind } of entries) {
      const record = kind === "static" ? meta[sourceName] : (yearSeries[sourceName] || [])[0];
      if (!record) continue;
      const columnMeta = sources[sourceName].columns || {};
      // IDs, free text, and JSON blobs are excluded here: they don't say
      // anything useful as a KPI or a chart. They're still in the
      // original file if actually needed.
      const columns = Object.keys(record).filter(
        (k) => k !== "year" && columnMeta[k] && columnMeta[k].plottable
      );
      if (!columns.length) continue;

      const sourceBox = document.createElement("div");
      sourceBox.className = "source-box";

      // Collapsed by default -- with dozens of tables each listing many
      // columns, showing everything at once makes the picker unusably
      // tall. Click the table name to expand/collapse its column list.
      const title = document.createElement("button");
      title.type = "button";
      title.className = "source-title source-toggle";
      title.textContent = `▸ ${sourceName} (${columns.length})`;
      sourceBox.appendChild(title);

      const columnList = document.createElement("div");
      columnList.className = "source-columns";
      columnList.style.display = "none";
      sourceBox.appendChild(columnList);

      title.addEventListener("click", () => {
        const expanded = columnList.style.display !== "none";
        columnList.style.display = expanded ? "none" : "";
        title.textContent = `${expanded ? "▸" : "▾"} ${sourceName} (${columns.length})`;
      });

      const sourceLabels = [];
      let anyPreChecked = false;
      for (const col of columns) {
        const key = `${sourceName}::${col}`;
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selected.has(key);
        if (box.checked) anyPreChecked = true;
        box.addEventListener("change", () => {
          if (box.checked) selected.add(key);
          else selected.delete(key);
          saveSelection(selected);
          renderSelection();
          // Keeps a row live-updating under "only show selected" -- checking
          // a box makes it stay visible (already selected), unchecking one
          // makes it drop out of view immediately, matching what the filter
          // name promises instead of requiring a manual re-toggle to see it.
          applyFilters();
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(col));
        if (columnMeta[col].dtype === "categorical" || columnMeta[col].dtype === "flag") {
          const tag = document.createElement("span");
          tag.className = "dtype-tag";
          tag.textContent = columnMeta[col].dtype;
          label.appendChild(tag);
        }
        const available = hasData(kind, sourceName, col, meta, yearSeries);
        const dot = document.createElement("span");
        dot.className = `data-dot ${available ? "data-dot-yes" : "data-dot-no"}`;
        dot.title = available ? `Has data for ${idGlims}` : `No data for ${idGlims}`;
        label.appendChild(dot);
        columnList.appendChild(label);
        sourceLabels.push(label);
        filterEntries.push({ label, col, sourceName, key, hasData: available });
      }
      // Start expanded when this table already has a saved selection in
      // it, so the restored checkmarks are actually visible instead of
      // hidden behind a collapsed "▸ table (n)" row.
      if (anyPreChecked) {
        columnList.style.display = "";
        title.textContent = `▾ ${sourceName} (${columns.length})`;
      }
      sourceBoxes.push({ box: sourceBox, title, columnList, sourceName, labels: sourceLabels });
      categoryBox.appendChild(sourceBox);
    }
    picker.appendChild(categoryBox);
  }
  root.appendChild(picker);

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    const dataOnly = dataOnlyBox.checked;
    const selectedOnly = selectedOnlyBox.checked;
    for (const { label, col, sourceName, key, hasData: available } of filterEntries) {
      const matchesText = !q || col.toLowerCase().includes(q) || sourceName.toLowerCase().includes(q);
      const matchesData = !dataOnly || available;
      const matchesSelected = !selectedOnly || selected.has(key);
      label.style.display = matchesText && matchesData && matchesSelected ? "" : "none";
    }
    for (const { box, title, columnList, sourceName, labels } of sourceBoxes) {
      const anyMatch = labels.some((l) => l.style.display !== "none");
      box.style.display = anyMatch ? "" : "none";
      // Auto-expand a table while a filter is narrowing its columns, so
      // the match is visible without an extra click; collapse it back once
      // every filter is cleared.
      const filtering = !!q || dataOnly || selectedOnly;
      const expanded = filtering && anyMatch;
      columnList.style.display = expanded ? "" : "none";
      title.textContent = `${expanded ? "▾" : "▸"} ${sourceName} (${labels.length})`;
    }
  }

  searchInput.addEventListener("input", applyFilters);
  dataOnlyBox.addEventListener("change", applyFilters);
  selectedOnlyBox.addEventListener("change", applyFilters);

  const kpiWrap = document.createElement("div");
  kpiWrap.className = "kpi-wrap";
  root.appendChild(kpiWrap);

  const chartsWrap = document.createElement("div");
  chartsWrap.className = "variable-charts";
  root.appendChild(chartsWrap);

  const downloadRow = document.createElement("div");
  downloadRow.className = "download-row";
  const csvButton = document.createElement("button");
  csvButton.textContent = "Download CSV";
  csvButton.addEventListener("click", () => downloadSelection());
  downloadRow.appendChild(csvButton);
  root.appendChild(downloadRow);

  let activeCharts = [];

  // clim_* columns route to climatologyCols (KPI) instead of temporalCols
  // (chart), even though their source table is "temporal" in sources.json
  // -- see isClimatology's note: they hold one constant value per glacier,
  // not a real per-year series.
  function splitSelection() {
    const staticCols = []; // [sourceName, col]
    const temporalCols = []; // [sourceName, col]
    const climatologyCols = []; // [sourceName, col]
    for (const key of selected) {
      const [sourceName, col] = key.split("::");
      const info = sources[sourceName];
      if (info.kind !== "static" && isClimatology(col)) climatologyCols.push([sourceName, col]);
      else (info.kind === "static" ? staticCols : temporalCols).push([sourceName, col]);
    }
    return { staticCols, temporalCols, climatologyCols };
  }

  function climatologyValue(sourceName, col) {
    const rows = yearSeries[sourceName] || [];
    const row = rows.find((r) => r[col] !== null && r[col] !== undefined);
    return row ? row[col] : null;
  }

  function buildRows(staticCols, temporalCols, climatologyCols) {
    const staticValues = {};
    for (const [sourceName, col] of staticCols) {
      staticValues[`${sourceName}: ${col}`] = (meta[sourceName] || {})[col];
    }
    for (const [sourceName, col] of climatologyCols) {
      staticValues[`${sourceName}: ${col}`] = climatologyValue(sourceName, col);
    }

    if (!temporalCols.length) {
      return { columns: Object.keys(staticValues), rows: [staticValues] };
    }

    const years = new Set();
    for (const [sourceName] of temporalCols) {
      for (const row of yearSeries[sourceName] || []) years.add(row.year);
    }
    const sortedYears = [...years].sort((a, b) => a - b);

    const columns = ["year", ...temporalCols.map(([s, c]) => `${s}: ${c}`), ...Object.keys(staticValues)];
    const rows = sortedYears.map((year) => {
      const row = { year, ...staticValues };
      for (const [sourceName, col] of temporalCols) {
        const match = (yearSeries[sourceName] || []).find((r) => r.year === year);
        row[`${sourceName}: ${col}`] = match ? match[col] : null;
      }
      return row;
    });
    return { columns, rows };
  }

  function downloadSelection() {
    const { staticCols, temporalCols, climatologyCols } = splitSelection();
    const { columns, rows } = buildRows(staticCols, temporalCols, climatologyCols);
    if (!rows.length || !columns.length) return;
    downloadCsv(toCsv(rows, columns), `${idGlims}_variables.csv`);
  }

  function appendKpiCard(sourceName, col, value) {
    const card = document.createElement("div");
    card.className = "kpi-card";
    const label = document.createElement("div");
    label.className = "kpi-label";
    label.textContent = col;
    const val = document.createElement("div");
    val.className = "kpi-value";
    val.textContent = value === null || value === undefined ? "--" : value;
    const source = document.createElement("div");
    source.className = "kpi-source";
    source.textContent = sourceName;
    card.appendChild(label);
    card.appendChild(val);
    card.appendChild(source);
    kpiWrap.appendChild(card);
  }

  function renderKpis(staticCols, climatologyCols) {
    kpiWrap.innerHTML = "";
    for (const [sourceName, col] of staticCols) {
      appendKpiCard(sourceName, col, (meta[sourceName] || {})[col]);
    }
    for (const [sourceName, col] of climatologyCols) {
      appendKpiCard(sourceName, col, climatologyValue(sourceName, col));
    }
  }

  function renderCharts(temporalCols) {
    for (const chart of activeCharts) chart.dispose();
    activeCharts = [];
    chartsWrap.innerHTML = "";

    for (const [sourceName, col] of temporalCols) {
      const rows = (yearSeries[sourceName] || []).slice().sort((a, b) => a.year - b.year);

      const box = document.createElement("div");
      // figure-box gives this the same expand/collapse behavior (and
      // fixed-overlay CSS) as every other chart in the app -- without it,
      // this was the only chart type with no expand/collapse control.
      box.className = "variable-chart-box figure-box";
      const title = document.createElement("div");
      title.className = "source-title";
      title.textContent = `${sourceName}: ${col}`;
      const chartDiv = document.createElement("div");
      chartDiv.className = "variable-chart";
      const downloadRow = document.createElement("div");
      downloadRow.className = "download-row";
      box.appendChild(title);
      box.appendChild(chartDiv);
      box.appendChild(downloadRow);
      chartsWrap.appendChild(box);

      const chart = echarts.init(chartDiv);

      // Watches the box's real size (expand/collapse included) instead of
      // resizing only right after the toggle click -- matches wireDownloads
      // in main.js, whose fixed-position expand overlay doesn't reliably
      // finish its layout pass by the very next animation frame.
      const resizeObserver = new ResizeObserver(() => chart.resize());
      resizeObserver.observe(chartDiv);
      chart.on("dispose", () => resizeObserver.disconnect());

      const expandToggle = document.createElement("button");
      expandToggle.className = "expand-toggle";
      expandToggle.textContent = "Expand";
      expandToggle.addEventListener("click", () => {
        box.classList.toggle("expanded");
        expandToggle.textContent = box.classList.contains("expanded") ? "Collapse" : "Expand";
      });
      box.appendChild(expandToggle);
      chart.setOption({
        xAxis: { type: "value", name: "year", scale: true },
        yAxis: { type: "value", name: col, scale: true },
        dataZoom: [{ type: "inside" }],
        tooltip: {
          trigger: "axis",
          formatter: (params) =>
            params.map((p) => `${p.marker || ""}${p.seriesName}, ${p.data[0]}: ${p.data[1]}`).join("<br/>"),
        },
        series: [{
          type: "line",
          smooth: true,
          data: rows.map((r) => [r.year, r[col]]),
          itemStyle: { color: "#2a6fb0" },
        }],
      });
      activeCharts.push(chart);

      addDownloadButtons(downloadRow, chart, `${idGlims}_${sourceName}_${col}`, SINGLE_SHEET, () => ({
        columns: ["year", col],
        rows: rows.map((r) => ({ year: r.year, [col]: r[col] })),
      }));
    }
  }

  function renderSelection() {
    const { staticCols, temporalCols, climatologyCols } = splitSelection();

    if (!staticCols.length && !temporalCols.length && !climatologyCols.length) {
      kpiWrap.innerHTML = "";
      chartsWrap.innerHTML = "<p class=\"variable-hint\">Select variables above: static/climatology ones show as KPIs, per-year ones as charts.</p>";
      for (const chart of activeCharts) chart.dispose();
      activeCharts = [];
      return;
    }

    renderKpis(staticCols, climatologyCols);
    renderCharts(temporalCols);
  }

  renderSelection();

  return () => {
    for (const chart of activeCharts) chart.dispose();
  };
}
