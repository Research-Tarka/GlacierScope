import { selectGlacier } from "./state.js";
import { loadOutlinesInBbox } from "./data.js";

// Leaflet blocks text selection globally (window-level "selectstart")
// while a drag is in progress, and only lifts it on the drag's own mouseup.
// If that mouseup happens outside the window (drag released off-tab, or the
// tab loses focus mid-drag), the block never lifts and the whole page stays
// unselectable until reload. Force it back on after any pointer release,
// map drag or not, as a safety net.
function installTextSelectionSafetyNet() {
  const reenable = () => L.DomUtil.enableTextSelection();
  document.addEventListener("mouseup", reenable);
  document.addEventListener("pointerup", reenable);
  document.addEventListener("touchend", reenable);
}

let mapInstance = null;
let highlightLayer = null;
let refOutlinesLayer = null;
let refOutlinesRequestToken = 0;

// Zoomed out past this, the world map is a wall of 20k+ overlapping
// polygons that's both unreadable and a heavy fetch/render for no benefit
// -- markers alone are enough to navigate at that scale. Only fetch and
// draw reference footprints once the user has zoomed in enough that they
// read as individual glacier delimitations.
const OUTLINE_MIN_ZOOM = 10;

async function refreshRefOutlines(map) {
  if (map.getZoom() < OUTLINE_MIN_ZOOM) {
    if (refOutlinesLayer) {
      map.removeLayer(refOutlinesLayer);
      refOutlinesLayer = null;
    }
    return;
  }

  const bounds = map.getBounds();
  const token = ++refOutlinesRequestToken;
  let outlines;
  try {
    outlines = await loadOutlinesInBbox(
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()
    );
  } catch (err) {
    console.warn("failed to load reference outlines for viewport", err);
    return;
  }
  if (token !== refOutlinesRequestToken) return; // a newer viewport request superseded this one

  if (refOutlinesLayer) map.removeLayer(refOutlinesLayer);
  refOutlinesLayer = L.geoJSON(outlines, {
    style: { color: "#2a6fb0", weight: 1.5, fillColor: "#2a6fb0", fillOpacity: 0.15 },
    onEachFeature: (feature, layer) => {
      layer.on("click", () => selectGlacier(feature.properties.id_glims));
    },
  }).addTo(map);
}

// Draws the glacier's actual footprint on the world map once it's known
// (fetched lazily on selection, like everything else per-glacier) --
// before that the map only ever shows a point marker, which reads as
// "no delimitation" for a glacier that hasn't been clicked yet.
export function setSelectedOutline(outlineGeojson) {
  if (!mapInstance) return;
  if (highlightLayer) {
    mapInstance.removeLayer(highlightLayer);
    highlightLayer = null;
  }
  if (!outlineGeojson) return;
  highlightLayer = L.geoJSON(outlineGeojson, {
    style: { color: "#c0392b", weight: 2, fillColor: "#c0392b", fillOpacity: 0.25 },
  }).addTo(mapInstance);
}

export function initMap(indexRows) {
  installTextSelectionSafetyNet();
  const map = L.map("map");
  mapInstance = map;

  // Routed through serve.py's own /tiles/{z}/{x}/{y}.png instead of
  // OpenStreetMap's CDN directly -- the server caches every tile it fetches
  // to disk (viewer/data/.tile_cache/), so any area already panned/zoomed
  // into once is available with no network on a later offline run. First
  // visit to a new area still needs a connection (nothing to serve from
  // cache yet); already-cached tiles are served instantly either way.
  L.tileLayer("tiles/{z}/{x}/{y}.png", {
    attribution: "OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);

  const cluster = L.markerClusterGroup({ chunkedLoading: true });

  const lats = [];
  const lons = [];

  for (const row of indexRows) {
    if (row.centroid_lat == null || row.centroid_lon == null) continue;
    lats.push(row.centroid_lat);
    lons.push(row.centroid_lon);

    const marker = L.marker([row.centroid_lat, row.centroid_lon]);
    marker.on("click", () => selectGlacier(row.id_glims));
    marker.bindTooltip(row.id_glims);
    cluster.addLayer(marker);
  }

  map.addLayer(cluster);

  if (lats.length) {
    const bounds = L.latLngBounds(
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)]
    );
    map.fitBounds(bounds);
  } else {
    map.setView([0, 0], 2);
  }

  // A drag fires many moveend events in quick succession (pan momentum,
  // intermediate frames) -- without debouncing, each one kicks off its own
  // bbox fetch, almost all of which get thrown away the instant a newer one
  // supersedes them (see refOutlinesRequestToken above). Waiting a short
  // idle gap after the last move event collapses that burst into a single
  // request for wherever the map actually settled.
  let refreshTimer = null;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshRefOutlines(map), 180);
  };
  map.on("moveend zoomend", scheduleRefresh);
  refreshRefOutlines(map);

  return map;
}
