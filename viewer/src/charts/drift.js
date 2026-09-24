// Reproduces the trajectory fit from the reference pipeline
// (Visualize/09_Visualizer.py, _add_centroid_traces): a degree-<=2
// polynomial per axis (x/y[/z]) fit against year, evaluated on a dense
// grid to draw a smooth curve instead of a straight first-year->last-year
// chord -- a chord can point in a visually wrong direction whenever the
// centroid moved non-monotonically. The "recent direction" tip is whichever
// end of the fitted curve sits closest to the mean of the last-5-years'
// actual points, matching the reference exactly.
function polyfit(x, y, degree) {
  // Least-squares fit via the normal equations (Vandermonde^T * Vandermonde),
  // solved with Gaussian elimination -- no matrix library available here,
  // and degree is always 0, 1, or 2 so the system is at most 3x3.
  const n = degree + 1;
  const V = x.map((xi) => {
    const row = new Array(n);
    let p = 1;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = p;
      p *= xi;
    }
    return row;
  });

  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let r = 0; r < V.length; r++) {
    for (let i = 0; i < n; i++) {
      b[i] += V[r][i] * y[r];
      for (let j = 0; j < n; j++) A[i][j] += V[r][i] * V[r][j];
    }
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    if (Math.abs(A[col][col]) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const factor = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }
  const coeffs = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r][c] * coeffs[c];
    coeffs[r] = Math.abs(A[r][r]) < 1e-12 ? 0 : sum / A[r][r];
  }
  return coeffs; // highest degree first, matches numpy.polyfit order
}

function polyval(coeffs, x) {
  let result = 0;
  for (const c of coeffs) result = result * x + c;
  return result;
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function dist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// Per-feature trajectory: `keys` gives the row properties to use as axes
// (2 for the 2D chart, 3 for the 3D chart). Returns null if there's not
// enough data to fit a trajectory.
export function driftTrajectory(rows, keys) {
  if (rows.length < 2) return null;

  const byYear = new Map();
  for (const r of rows) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length < 2) return null;

  const axisMeans = keys.map((key) => years.map((year) => mean(byYear.get(year).map((r) => r[key]))));

  const degree = Math.min(2, years.length - 1);
  const tOrigin = mean(years);
  const tFit = years.map((y) => y - tOrigin);

  const nInterp = Math.max(180, years.length * 40);
  const tInterp = [];
  const yMin = years[0];
  const yMax = years[years.length - 1];
  for (let i = 0; i < nInterp; i++) {
    tInterp.push(yMin + ((yMax - yMin) * i) / (nInterp - 1));
  }

  const curves = axisMeans.map((axisSeries) => {
    const coeffs = polyfit(tFit, axisSeries, degree);
    return tInterp.map((t) => polyval(coeffs, t - tOrigin));
  });

  const curvePoints = tInterp.map((_, i) => curves.map((curve) => curve[i]));
  const curveStart = curvePoints[0];
  const curveEnd = curvePoints[curvePoints.length - 1];

  const nRecent = Math.min(5, years.length);
  const recentYears = years.slice(years.length - nRecent);
  const recentPoints = recentYears.map((year) => keys.map((key) => mean(byYear.get(year).map((r) => r[key]))));

  const distStart = mean(recentPoints.map((p) => dist(p, curveStart)));
  const distEnd = mean(recentPoints.map((p) => dist(p, curveEnd)));
  const tip = distEnd <= distStart ? curveEnd : curveStart;

  return {
    curve: curvePoints,
    tip,
    startYear: recentYears[0],
    endYear: recentYears[recentYears.length - 1],
  };
}
