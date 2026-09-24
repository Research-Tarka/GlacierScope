import { selectGlacier } from "./state.js";

export function initSearch(indexRows) {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");

  input.addEventListener("input", () => {
    const query = input.value.trim().toUpperCase();
    results.innerHTML = "";
    if (query.length < 2) return;

    const matches = indexRows
      .filter((row) => row.id_glims.includes(query))
      .slice(0, 20);

    for (const row of matches) {
      const item = document.createElement("div");
      item.textContent = row.id_glims;
      item.addEventListener("click", () => {
        selectGlacier(row.id_glims);
        input.value = row.id_glims;
        results.innerHTML = "";
      });
      results.appendChild(item);
    }
  });

  document.addEventListener("click", (event) => {
    if (!results.contains(event.target) && event.target !== input) {
      results.innerHTML = "";
    }
  });
}
