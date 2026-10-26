import { mountDataView } from "./vendor/agentic-base-browser-data-view.js?v=c104152";

const grid = document.querySelector("#catalog-grid");
const empty = document.querySelector("#catalog-empty");
const search = document.querySelector("#catalog-search");
const searchStatus = document.querySelector("#search-status");
const catalogUrl = new URL("./catalog.json", location.href);
const inventoryUrl = new URL("./review-inventory.json", location.href);
const inventoryTable = document.querySelector("#inventory-table-mount");
const inventorySearch = document.querySelector("#inventory-search");
const inventorySearchForm = document.querySelector("#inventory-search-form");
const inventorySearchToggle = document.querySelector("#inventory-search-toggle");
const inventoryViewOptions = document.querySelector("#inventory-view-options");
const concernFilter = document.querySelector("#inventory-concern");
const groupBy = document.querySelector("#inventory-group");
const sortBy = document.querySelector("#inventory-sort");
const decisionFilter = document.querySelector("#inventory-decision-filter");
const inventoryStatus = document.querySelector("#inventory-status");
const decisionSummary = document.querySelector("#inventory-decision-summary");
const inventoryTablePanel = document.querySelector("#inventory-table-panel");
const storageNote = document.querySelector("#inventory-storage-note");
const selectedSummary = document.querySelector("#inventory-selected-brief");
const selectedDetails = document.querySelector("#inventory-selected-details");
const selectedDetailsText = document.querySelector("#inventory-selected-full");
const reviewControls = document.querySelector("#inventory-review-controls");
const inventoryModeButtons = [...document.querySelectorAll("[data-inventory-mode]")];
const keepSelected = document.querySelector("#inventory-keep-selected");
const removeSelected = document.querySelector("#inventory-remove-selected");
const allowedConcerns = new Set(["token", "brand-profile", "guideline", "accessibility", "component", "example"]);
const reviewConcerns = new Set(["Token", "Theme", "Component", "Brand profile", "Guideline", "Accessibility", "Example"]);
const catalogRecords = [];
let inventoryRows = [];
let decisions = {};
let decisionStorage = true;
let decisionStorageKey = "";
let selectedRowId = null;
let selectedRowIds = new Set();
let tableHandle = null;
let inventoryGroups = new Map();
let reviewOnly = false;

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertCatalog(catalog) {
  if (catalog.$schema !== "./catalog.schema.json" || catalog.catalogId !== "agentic-design-system"
    || catalog.requestedPath !== "/agentic-design-system/" || !/^\d+\.\d+\.\d+$/.test(catalog.schemaVersion || "")
    || !Array.isArray(catalog.records) || !catalog.release?.version
    || !["draft", "released", "deprecated"].includes(catalog.release.status)) throw new Error("Catalog contract is incomplete");
  if (catalog.release.status !== "released" && catalog.records.length > 0) throw new Error("Draft catalog cannot expose records");
  if (catalog.release.status === "released" && (!/^[a-f0-9]{40}$/.test(catalog.release.sourceRevision || "")
    || !/^sha256:[a-f0-9]{64}$/.test(catalog.release.manifestDigest || ""))) throw new Error("Release identity is incomplete");
  const ids = new Set();
  const keys = new Set();
  for (const record of catalog.records) {
    const source = record.source;
    const rights = record.rights;
    const validId = typeof record.id === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(record.id);
    const validSource = source && hasText(source.repository) && /^[a-f0-9]{40}$/.test(source.revision || "")
      && hasText(source.path) && /^sha256:[a-f0-9]{64}$/.test(source.digest || "");
    const validRights = rights && hasText(rights.license) && hasText(rights.attribution) && hasText(rights.permissionEvidence);
    const key = typeof record.canonicalKey === "string" ? record.canonicalKey.trim().toLocaleLowerCase() : "";
    const validKey = record.canonicalKey === key && /^[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)*$/.test(key);
    if (!validId || ids.has(record.id) || !validKey || keys.has(key) || record.status !== "cleared" || !allowedConcerns.has(record.concern)
      || !hasText(record.name) || !hasText(record.summary) || !hasText(record.owner)
      || !validSource || !validRights || !Array.isArray(record.evidence)
      || record.evidence.length === 0 || record.evidence.some((item) => !hasText(item))) {
      throw new Error("Catalog contains an incomplete, duplicate, or uncleared public record");
    }
    ids.add(record.id);
    keys.add(key);
  }
}

function renderCatalog(query = "") {
  const needle = query.trim().replace(/^@/, "").toLocaleLowerCase();
  const shown = catalogRecords.filter((record) => [record.id, record.name, record.concern, record.status, record.summary]
    .join(" ").toLocaleLowerCase().includes(needle));
  grid.replaceChildren();
  for (const record of shown) {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    const detail = document.createElement("p");
    const metadata = document.createElement("dl");
    const evidenceHeading = document.createElement("h4");
    const evidence = document.createElement("ul");
    article.className = "catalog-card";
    metadata.className = "catalog-meta";
    evidence.className = "catalog-evidence";
    heading.textContent = `${record.name} · @${record.id}`;
    detail.textContent = record.summary;
    evidenceHeading.textContent = "Evidence";
    const fields = [
      ["Canonical key", record.canonicalKey], ["Owner", record.owner],
      ["Source", `${record.source.repository}@${record.source.revision}:${record.source.path}`],
      ["Source digest", record.source.digest], ["Reuse license", record.rights.license],
      ["Attribution", record.rights.attribution], ["Permission evidence", record.rights.permissionEvidence], ["Status", record.status],
    ];
    for (const [label, value] of fields) {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      metadata.append(term, description);
    }
    for (const item of record.evidence) {
      const entry = document.createElement("li");
      entry.textContent = item;
      evidence.append(entry);
    }
    article.append(heading, detail, metadata, evidenceHeading, evidence);
    grid.append(article);
  }
  empty.hidden = shown.length > 0;
  empty.textContent = catalogRecords.length === 0
    ? "No public catalog records are cleared yet. Rights, source owner, exact revision, and required evidence must be verified before an entry appears here."
    : "No catalog entry matches that search.";
  searchStatus.textContent = `${shown.length} ${shown.length === 1 ? "entry" : "entries"} shown.`;
}

function slugify(value) {
  return String(value).normalize("NFKD").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function flattenInventory(inventory) {
  if (inventory.$schema !== "agentic-design-system/review-inventory/v1"
    || inventory.inventoryId !== "agentic-graph-design-system-review"
    || inventory.classification !== "local-review-inventory"
    || inventory.publication !== "not-cleared; not a catalog release"
    || !/^[a-f0-9]{40}$/.test(inventory.sourceRevision || "") || !Array.isArray(inventory.collections)) {
    throw new Error("Review inventory identity is incomplete");
  }
  const collectionIds = new Set();
  const rowIds = new Set();
  const canonicalKeys = new Set();
  const rows = [];
  for (const collection of inventory.collections) {
    if (!collection || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(collection.id || "")
      || collectionIds.has(collection.id) || !reviewConcerns.has(collection.concern)
      || !hasText(collection.group) || !hasText(collection.owner) || !hasText(collection.sourceRole)
      || !/^[a-f0-9]{40}$/.test(collection.revision || "") || !hasText(collection.reuseGate)
      || !Array.isArray(collection.elements) || collection.elements.length === 0) {
      throw new Error("Review inventory contains an incomplete or duplicate collection");
    }
    collectionIds.add(collection.id);
    for (const element of collection.elements) {
      const slug = slugify(element?.name);
      const id = `${collection.id}.${slug}`;
      const canonicalKey = `${collection.id}:${slug}`;
      if (!slug || rowIds.has(id) || canonicalKeys.has(canonicalKey) || !hasText(element.sourcePath)) {
        throw new Error("Review inventory contains an incomplete or duplicate element");
      }
      rowIds.add(id);
      canonicalKeys.add(canonicalKey);
      rows.push({
        id, canonicalKey, concern: collection.concern, name: element.name, group: collection.group,
        owner: collection.owner, sourceRole: element.sourceRole || collection.sourceRole,
        revision: collection.revision, sourcePath: element.sourcePath, reuseGate: collection.reuseGate,
      });
    }
  }
  if (rows.length !== inventory.recordCount) throw new Error("Review inventory row count does not match its source manifest");
  return rows;
}

function loadDecisions() {
  decisionStorageKey = `agentic-design-system-review:${inventoryRows[0]?.revision || "empty"}`;
  try {
    const saved = JSON.parse(localStorage.getItem(decisionStorageKey) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([id, value]) =>
      inventoryRows.some((row) => row.id === id) && ["keep", "remove"].includes(value)));
  } catch {
    decisionStorage = false;
    storageNote.textContent = "Browser storage is unavailable. Your decisions will last only until this page closes.";
    return {};
  }
}

function saveDecisions() {
  if (!decisionStorage) return;
  try {
    localStorage.setItem(decisionStorageKey, JSON.stringify(decisions));
    storageNote.textContent = "Decisions stay in this browser unless you export them.";
  } catch {
    decisionStorage = false;
    storageNote.textContent = "Browser storage is unavailable. Your decisions will last only until this page closes.";
  }
}

function decisionCounts() {
  let keep = 0;
  let remove = 0;
  for (const decision of Object.values(decisions)) {
    if (decision === "keep") keep += 1;
    if (decision === "remove") remove += 1;
  }
  return { keep, remove, pending: inventoryRows.length - keep - remove };
}

function updateSelectedSummary() {
  const item = inventoryRows.find((row) => row.id === selectedRowId);
  const group = inventoryGroups.get(selectedRowId);
  reviewControls.hidden = !item && !group;
  keepSelected.disabled = !item;
  removeSelected.disabled = !item;
  if (!item) {
    selectedSummary.textContent = group
      ? `${group.label} · ${group.items.length} elements · select an element to review`
      : "";
    selectedDetails.hidden = true;
    selectedDetailsText.textContent = "";
    return;
  }
  const decision = (decisions[item.id] || "pending").toLocaleUpperCase();
  selectedSummary.textContent = `${item.name} · ${decision}`;
  selectedDetails.hidden = false;
  selectedDetailsText.textContent = `${item.owner} · ${item.group} · ${item.sourceRole} · ${item.sourcePath} · ${item.revision} · ${item.reuseGate}`;
}

function decideSelected(value) {
  if (!inventoryRows.some((row) => row.id === selectedRowId)) return;
  decisions[selectedRowId] = value;
  saveDecisions();
  renderInventory();
}

function renderInventory() {
  const query = inventorySearch.value.trim().toLocaleLowerCase();
  const selectedConcern = concernFilter.value;
  const selectedDecision = decisionFilter.value;
  const matching = inventoryRows.filter((item) => {
    const decision = decisions[item.id] || "pending";
    const text = [item.name, item.concern, item.group, item.owner, item.sourceRole, item.revision, item.sourcePath, item.reuseGate, item.id]
      .join(" ").toLocaleLowerCase();
    return (!query || text.includes(query.replace(/^@/, "")))
      && (!selectedConcern || item.concern === selectedConcern)
      && (!selectedDecision || decision === selectedDecision)
      && (!reviewOnly || decision !== "pending");
  });
  const groupDimension = groupBy.value;
  const sortDimension = sortBy.value;
  matching.sort((left, right) => {
    if (groupDimension !== "none") {
      const byGroup = left[groupDimension].localeCompare(right[groupDimension], undefined, { numeric: true, sensitivity: "base" });
      if (byGroup) return byGroup;
    }
    return left[sortDimension].localeCompare(right[sortDimension], undefined, { numeric: true, sensitivity: "base" })
      || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
  const groupRows = [];
  inventoryGroups = new Map();
  if (groupDimension !== "none") {
    let currentGroup = "";
    for (let index = 0; index < matching.length;) {
      const label = matching[index][groupDimension];
      const items = [];
      while (index < matching.length && matching[index][groupDimension] === label) items.push(matching[index++]);
      const id = `group:${groupDimension}:${groupRows.length}:${slugify(label)}`;
      const group = { id, label, items };
      inventoryGroups.set(id, group);
      groupRows.push({ id, depth: 1, cells: [label, "map", "", "", `${items.length} elements`, ""] });
      groupRows.push(...items.map((item) => ({
        id: item.id, depth: 2,
        cells: [item.name, "scalar", item.concern, item.sourcePath, item.sourceRole,
          (decisions[item.id] || "pending").toLocaleUpperCase()],
      })));
    }
  }
  if (groupDimension === "none") {
    groupRows.push(...matching.map((item) => ({
      id: item.id, depth: 1,
      cells: [item.name, "scalar", item.concern, item.sourcePath, item.sourceRole,
        (decisions[item.id] || "pending").toLocaleUpperCase()],
    })));
  }
  const selectableRowIds = new Set(groupRows.map((row) => row.id));
  selectedRowIds = new Set([...selectedRowIds].filter((rowId) => selectableRowIds.has(rowId)));
  if (!selectableRowIds.has(selectedRowId)) selectedRowId = null;
  const tableState = {
    columns: [
      { id: "key", name: "Key", kind: "text" }, { id: "type", name: "Type", kind: "select" },
      { id: "scalar-value", name: "Scalar Value", kind: "select" },
      { id: "list-value", name: "List Value", kind: "text" }, { id: "summary", name: "Summary", kind: "text" },
      { id: "output", name: "Output", kind: "select" },
    ],
    rows: groupRows,
    selectedRowId,
    selectedRowIds: [...selectedRowIds],
    ariaLabel: "Agentic Graph design system inventory",
    onSelectionChange: (rowIds) => {
      selectedRowIds = new Set(rowIds.filter((rowId) => selectableRowIds.has(rowId)));
      renderInventory();
    },
    onActivateRow: (rowId) => {
      if (!selectableRowIds.has(rowId)) return;
      selectedRowId = rowId;
      renderInventory();
    },
    onDeselectRow: (rowId) => {
      if (selectedRowId !== rowId) return;
      selectedRowId = null;
      renderInventory();
    },
  };
  if (tableHandle) tableHandle.update(tableState);
  else {
    tableHandle = mountDataView(inventoryTable, tableState);
    inventoryTable.closest(".inventory-table-region")?.scrollTo({ left: 0, top: 0 });
  }
  updateSelectedSummary();
  const counts = decisionCounts();
  decisionSummary.textContent = `${counts.keep} keep · ${counts.remove} remove · ${counts.pending} pending`;
  for (const button of inventoryModeButtons) {
    const active = (button.dataset.inventoryMode === "reviewed") === reviewOnly;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  inventoryTablePanel.setAttribute("aria-labelledby", reviewOnly ? "inventory-reviewed-tab" : "inventory-source-tab");
  const paging = matching.length > 32 ? " Use Show more records in the table to continue through the matching rows." : "";
  inventoryStatus.textContent = `${matching.length} of ${inventoryRows.length} source-linked elements match. Decisions are local review notes, not reuse approval.${paging}`;
}

function setInventorySearchExpanded(expanded, focus = false) {
  inventorySearchForm.hidden = !expanded;
  inventorySearchToggle.setAttribute("aria-expanded", String(expanded));
  if (expanded && focus) inventorySearch.focus();
  if (!expanded) inventorySearchToggle.focus();
}

function exportDecisions() {
  const payload = {
    schema: "agentic-design-system/local-review-decisions/v1",
    inventoryId: "agentic-graph-design-system-review",
    sourceRevision: inventoryRows[0]?.revision ?? null,
    decisions: inventoryRows.filter((item) => decisions[item.id]).map((item) => ({
      id: item.id, canonicalKey: item.canonicalKey, name: item.name, sourceRole: item.sourceRole, decision: decisions[item.id],
    })),
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = "agentic-graph-design-system-review.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function populateConcernFilter() {
  const concerns = [...new Set(inventoryRows.map((item) => item.concern))].sort();
  concernFilter.replaceChildren(new Option("All concerns", ""));
  for (const concern of concerns) concernFilter.append(new Option(concern, concern));
}

fetch(catalogUrl, { cache: "no-cache" })
  .then((response) => {
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    return response.json();
  })
  .then((catalog) => {
    assertCatalog(catalog);
    catalogRecords.push(...catalog.records);
    document.querySelector("#release-summary").textContent = `Release ${catalog.release.version} · ${catalog.release.status} · ${catalog.records.length} public records · predecessor ${catalog.release.predecessor || "none"} · digest ${catalog.release.manifestDigest || "pending"}`;
    renderCatalog(search.value);
  })
  .catch(() => {
    document.querySelector("#release-summary").textContent = "Catalog unavailable; reconnect once to load and cache it.";
    empty.hidden = false;
    searchStatus.textContent = "Catalog could not be loaded or did not satisfy its publication contract.";
  });

fetch(inventoryUrl, { cache: "no-cache" })
  .then((response) => {
    if (!response.ok) throw new Error(`Inventory request failed: ${response.status}`);
    return response.json();
  })
  .then((inventory) => {
    inventoryRows = flattenInventory(inventory);
    decisions = loadDecisions();
    document.querySelector("#inventory-source").textContent = `${inventoryRows.length} review-only elements · Graph ${inventory.sourceRevision}`;
    populateConcernFilter();
    renderInventory();
  })
  .catch(() => {
    document.querySelector("#inventory-source").textContent = "No review inventory is included in this build.";
    inventoryStatus.textContent = "The public catalog remains independent of this optional review inventory.";
    inventoryTable.textContent = "No review inventory is included in this build.";
  });

search.addEventListener("input", () => renderCatalog(search.value));
inventorySearchToggle.addEventListener("click", () => {
  if (inventorySearchForm.hidden) {
    setInventorySearchExpanded(true, true);
    return;
  }
  if (inventorySearch.value) {
    inventorySearch.value = "";
    renderInventory();
  }
  setInventorySearchExpanded(false);
});
inventorySearch.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (inventorySearch.value) {
    inventorySearch.value = "";
    renderInventory();
  }
  setInventorySearchExpanded(false);
});
inventorySearch.addEventListener("blur", () => {
  if (!inventorySearch.value.trim()) setInventorySearchExpanded(false);
});
for (const button of document.querySelectorAll("[data-focus-inventory-control]")) {
  button.addEventListener("click", () => {
    inventoryViewOptions.open = true;
    document.querySelector(`#${button.dataset.focusInventoryControl}`)?.focus();
  });
}
for (const menu of document.querySelectorAll(".inventory-menu")) {
  menu.addEventListener("toggle", () => {
    menu.querySelector("summary")?.setAttribute("aria-expanded", String(menu.open));
    if (!menu.open) return;
    for (const other of document.querySelectorAll(".inventory-menu")) {
      if (other !== menu) {
        other.open = false;
        other.querySelector("summary")?.setAttribute("aria-expanded", "false");
      }
    }
  });
}
for (const control of [inventorySearch, concernFilter, groupBy, sortBy, decisionFilter]) {
  control.addEventListener("input", renderInventory);
  control.addEventListener("change", renderInventory);
}
for (const button of inventoryModeButtons) {
  button.addEventListener("click", () => {
    reviewOnly = button.dataset.inventoryMode === "reviewed";
    renderInventory();
  });
  button.addEventListener("keydown", (event) => {
    const index = inventoryModeButtons.indexOf(button);
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % inventoryModeButtons.length
      : event.key === "ArrowLeft" ? (index + inventoryModeButtons.length - 1) % inventoryModeButtons.length
        : event.key === "Home" ? 0 : event.key === "End" ? inventoryModeButtons.length - 1 : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = inventoryModeButtons[nextIndex];
    reviewOnly = next.dataset.inventoryMode === "reviewed";
    renderInventory();
    next.focus();
  });
}
document.querySelector("#inventory-export").addEventListener("click", exportDecisions);
keepSelected.addEventListener("click", () => decideSelected("keep"));
removeSelected.addEventListener("click", () => decideSelected("remove"));
document.querySelector("#inventory-clear").addEventListener("click", () => {
  if (!Object.keys(decisions).length || !window.confirm("Clear all review decisions saved in this browser?")) return;
  decisions = {};
  saveDecisions();
  renderInventory();
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" })
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      if (!registration.active) throw new Error("Offline worker is not active");
      document.querySelector("#offline-status").textContent = "Offline cache is ready for this site.";
    })
    .catch(() => { document.querySelector("#offline-status").textContent = "Offline cache could not be prepared on this browser."; });
} else {
  document.querySelector("#offline-status").textContent = "Offline cache is unavailable on this protocol or browser.";
}
