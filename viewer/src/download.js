function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadPng(chart, name) {
  const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#fff" });
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.png`;
  link.click();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// The chart option is embedded as a JSON literal inside a <script> block --
// "</script" inside a string value would otherwise close the script tag
// early and let its remainder be parsed as HTML/markup.
function jsonForScriptTag(value) {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

function downloadHtml(chart, name) {
  const option = chart.getOption();
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head>
<body>
<div id="chart" style="width:100vw;height:100vh"></div>
<script src="https://unpkg.com/echarts@5.5.1/dist/echarts.min.js"></script>
<script src="https://unpkg.com/echarts-gl@2.0.9/dist/echarts-gl.min.js"></script>
<script>
  const chart = echarts.init(document.getElementById("chart"));
  chart.setOption(${jsonForScriptTag(option)});
  window.addEventListener("resize", () => chart.resize());
</script>
</body>
</html>`;
  triggerDownload(new Blob([html], { type: "text/html" }), `${name}.html`);
}

function toCsv(columns, rows) {
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

function downloadCsv(columns, rows, name) {
  triggerDownload(new Blob([toCsv(columns, rows)], { type: "text/csv" }), `${name}.csv`);
}

// csvSheetNames + getCsvSpec together make CSV export lazy: csvSheetNames
// (a plain array of sheet-button labels, or the single-table sentinel
// SINGLE_SHEET) is enough to draw the right buttons up front without
// touching the actual data, and getCsvSpec (the same shape as before -- a
// single {columns, rows} or a {sheetName: {columns, rows}, ...} map) is
// only called inside the click handler, once, for the sheet actually
// downloaded.
//
// This laziness matters because some charts' CSV shape (the full per-pixel
// classification stack behind the 2D/3D spatial evolution charts) is
// n_years x height x width rows -- building that eagerly for every glacier
// selection, most of which never download it, would undo the point of
// parallelizing/caching the rest of the per-glacier load.
export const SINGLE_SHEET = Symbol("single-sheet");

export function addDownloadButtons(container, chart, name, csvSheetNames, getCsvSpec) {
  container.innerHTML = "";

  const pngButton = document.createElement("button");
  pngButton.textContent = "PNG";
  pngButton.addEventListener("click", () => downloadPng(chart, name));

  const htmlButton = document.createElement("button");
  htmlButton.textContent = "Interactive HTML";
  htmlButton.addEventListener("click", () => downloadHtml(chart, name));

  container.appendChild(pngButton);
  container.appendChild(htmlButton);

  if (!csvSheetNames) return;

  const sheetNames = csvSheetNames === SINGLE_SHEET ? ["data"] : csvSheetNames;
  for (const sheetName of sheetNames) {
    const csvButton = document.createElement("button");
    csvButton.textContent = sheetName === "data" ? "CSV" : `CSV (${sheetName})`;
    csvButton.addEventListener("click", () => {
      const csvSpec = getCsvSpec();
      const sheets = csvSpec.columns ? { data: csvSpec } : csvSpec;
      const { columns, rows } = sheets[sheetName];
      const suffix = sheetName === "data" ? "" : `_${sheetName}`;
      downloadCsv(columns, rows, `${name}${suffix}`);
    });
    container.appendChild(csvButton);
  }
}
