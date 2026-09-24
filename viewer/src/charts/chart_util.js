// echarts.init on a container that already has a live instance (e.g. from a
// previous glacier whose render threw before it got disposed by
// disposeActiveCharts in main.js) returns that stale instance instead of a
// fresh one -- setOption on it can then throw "CHANGABLE_METHODS, t is
// undefined" from echarts' internal data-model wrapping. Always dispose
// first so every render starts from a clean instance.
export function freshChart(container) {
  const existing = echarts.getInstanceByDom(container);
  if (existing) existing.dispose();
  return echarts.init(container);
}

// A small reset-zoom button, top right, for every 2D chart with dataZoom --
// echarts' own toolbox.restore reverts the whole option to its initial
// setOption call, which also undoes zoom/pan.
export const RESET_ZOOM_TOOLBOX = {
  show: true,
  right: 6,
  top: 2,
  feature: { restore: { show: true, title: "Reset zoom" } },
};
