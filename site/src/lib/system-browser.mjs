import { createPaginationAdapter } from "./pagination-browser.mjs";

export function filterEntries(entries, query = "", category = "", kind = "", rarity = "") {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(item => (!needle || item.search.toLocaleLowerCase().includes(needle))
    && (!category || item.categories.split(" ").includes(category))
    && (!kind || item.kind === kind) && (!rarity || item.rarity === rarity));
}

class SystemBrowser extends (globalThis.HTMLElement || class {}) {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    this.pagination = createPaginationAdapter(this, { onChange: () => this.render() });
    this.entries = Array.from(this.querySelectorAll("[data-entry]")).map(node => ({ node,
      search: node.dataset.search || node.textContent || "", categories: node.dataset.categories || "",
      kind: node.dataset.kind || "", rarity: node.dataset.rarity || "" }));
    this.addEventListener("input", event => { if (event.target.matches("[data-filter]")) { this.pagination?.reset(); this.render(); } });
    this.addEventListener("click", event => {
      const categoryPill = event.target.closest("[data-category-pill]");
      if (categoryPill) {
        const select = this.querySelector('[data-filter="category"]');
        if (select) select.value = categoryPill.dataset.categoryPill || "";
        this.pagination?.reset();
        this.render();
        return;
      }
      if (event.target.closest("[data-reset]")) {
        this.querySelectorAll("[data-filter]").forEach(input => { input.value = ""; }); this.pagination?.reset(); this.render();
      }
    });
    this.render();
  }
  render() {
    const value = key => this.querySelector(`[data-filter="${key}"]`)?.value || "";
    const activeCategory = value("category");
    this.querySelectorAll("[data-category-pill]").forEach(button => {
      const active = (button.dataset.categoryPill || "") === activeCategory;
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const matched = filterEntries(this.entries, value("query"), activeCategory, value("kind"), value("rarity"));
    const result = this.pagination?.paginate(matched);
    const visible = new Set(result?.records ?? matched);
    this.entries.forEach(entry => { entry.node.hidden = !visible.has(entry); });
    this.querySelectorAll("[data-result-group]").forEach(group => {
      group.hidden = !group.querySelector("[data-entry]:not([hidden])");
    });
    const count = this.querySelector("[data-count]");
    if (count) count.textContent = `${matched.length}`;
    if (result) this.pagination.render(result);
    const empty = this.querySelector("[data-empty]");
    if (empty) empty.hidden = matched.length > 0;
  }
}
if (typeof customElements !== "undefined" && !customElements.get("system-browser")) customElements.define("system-browser", SystemBrowser);
