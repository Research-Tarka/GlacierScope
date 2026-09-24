const listeners = [];
let currentId = null;

export function selectGlacier(idGlims) {
  currentId = idGlims;
  for (const fn of listeners) fn(idGlims);
}

export function onGlacierSelected(fn) {
  listeners.push(fn);
}

export function getSelectedGlacier() {
  return currentId;
}
