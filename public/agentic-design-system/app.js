import { registerWebMcpTools, searchRegistry, validateRegistryContext } from "./registry-query.js?v=c104158";

const grid = document.querySelector("#catalog-grid");
const empty = document.querySelector("#catalog-empty");
const search = document.querySelector("#catalog-search");
const searchStatus = document.querySelector("#search-status");
const toolStatus = document.querySelector("#agent-tool-status");
const offlineStatus = document.querySelector("#offline-status");
const catalogNavigation = document.querySelector("#catalog-navigation");
const catalogUrl = new URL("./catalog.json", location.href);
let registryContext = null;

const sectionIndex = document.querySelector(".section-index");
const lateContent = [toolStatus, offlineStatus, document.querySelector("#release-summary"), document.querySelector("footer")];
function revealLateContent() {
  lateContent.forEach(element => { element.hidden = false; });
  const fragment = location.hash.slice(1);
  if (!fragment) return;
  let targetId = fragment;
  try { targetId = decodeURIComponent(fragment); } catch { /* Keep the literal fragment. */ }
  const target = document.getElementById(targetId);
  if (!target || target.closest("[hidden]")) return;
  requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new TypeError(`${label} fields are invalid`);
}

function assertCatalog(catalog) {
  exactKeys(catalog, ["$schema", "catalogId", "schemaVersion", "release", "requestedPath", "records", "registry", "iconLibrary"], "Catalog");
  exactKeys(catalog.release, ["version", "status", "sourceRevision", "manifestDigest", "predecessor"], "Release");
  if (catalog.$schema !== "./catalog.schema.json" || catalog.catalogId !== "agentic-design-system"
    || catalog.release.status !== "draft" || catalog.requestedPath !== "/agentic-design-system/"
    || !Array.isArray(catalog.records) || catalog.records.length !== 0
    || !Array.isArray(catalog.registry?.profiles) || catalog.registry.profiles.length !== 4) {
    throw new TypeError("The local catalog is incomplete or is not a draft");
  }
}

function addMetadata(container, fields) {
  const metadata = document.createElement("dl");
  metadata.className = "catalog-meta";
  for (const [label, value] of fields) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = String(value ?? "");
    metadata.append(term, description);
  }
  container.append(metadata);
}

function catalogCard(kind, name, accent, description) {
  const card = document.createElement("li");
  card.className = "agentic-dashboard-card";
  card.dataset.accent = accent;
  const eyebrow = document.createElement("p");
  eyebrow.className = "agentic-dashboard-eyebrow";
  eyebrow.textContent = kind;
  const heading = document.createElement("h3");
  heading.textContent = name;
  card.append(eyebrow, heading);
  if (description) {
    const detail = document.createElement("p");
    detail.className = "agentic-dashboard-description";
    detail.textContent = description;
    card.append(detail);
  }
  return card;
}

function addDisclosure(card, label) {
  const disclosure = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  disclosure.append(summary);
  card.append(disclosure);
  return disclosure;
}

function renderOwner(owner) {
  const card = catalogCard("Source owner", owner.name, "primary", owner.role);
  const evidence = addDisclosure(card, "Source and reuse evidence");
  addMetadata(evidence, [["Repository", owner.repository], ["Scope", owner.scopes.join(", ")],
    ["Pinned revision", owner.revision], ["Reuse gate", owner.reuseGate]]);
  const sources = document.createElement("ul");
  sources.className = "catalog-evidence";
  for (const source of owner.sources) {
    const item = document.createElement("li");
    item.textContent = `${source.kind}: ${source.path} · ${source.digest}`;
    sources.append(item);
  }
  evidence.append(sources);
  return card;
}

function tokenValue(token) {
  if (token.values) return `light ${token.values.light} · dark ${token.values.dark} · black ${token.values.black}`;
  if (token.type === "alias") return `alias of ${token.targetKey}`;
  if (token.type === "outline") return `${token.width} ${token.style} · ${token.colorKey}`;
  return token.value;
}

function renderProfile(profile, searching) {
  const card = catalogCard("Token profile", profile.name, "secondary",
    `${profile.status} · ${profile.rights} reuse · ${profile.scope.join(", ")}`);
  const disclosure = addDisclosure(card, `${profile.tokens.length} candidate keys · inspect values`);
  disclosure.open = searching && profile.tokens.length <= 10;
  const list = document.createElement("ul");
  list.className = "catalog-evidence";
  const pins = profile.consumerPins.length
    ? profile.consumerPins.map(pin => `${pin.repository}@${pin.revision}:${pin.path} · ${pin.digest}`).join("; ")
    : "No consumer adoption pin; candidate values only.";
  addMetadata(disclosure, [
    ["Owner", profile.owner], ["Scope", profile.scope.join(", ")],
    ["Source", `${profile.repository}@${profile.revision}:${profile.source}`], ["Profile digest", profile.digest],
    ["Rights", profile.rights], ["Permission", profile.permissionEvidence],
    ["License evidence", profile.licenseEvidence.map(item => `${item.repository}@${item.revision}:${item.path} · ${item.digest}`).join("; ")],
    ["Consumer pins", pins],
    ...(profile.projection ? [["Generated projection", `${profile.projection.path} · ${profile.projection.digest}`]] : []),
  ]);
  for (const token of profile.tokens) {
    const item = document.createElement("li");
    item.textContent = `${token.canonicalKey} · ${token.cssVar} · ${token.type} · ${tokenValue(token)}`;
    list.append(item);
  }
  disclosure.querySelector("summary").after(list);
  return card;
}

function renderRecord(record) {
  const card = catalogCard("Catalog record", `${record.name} · @${record.id.replace(/^catalog:/u, "")}`, "success", record.summary);
  addMetadata(card, [["Canonical key", record.canonicalKey], ["Owner", record.owner]]);
  return card;
}

function renderSection(section) {
  const card = catalogCard("Section", section.label, "neutral");
  const link = document.createElement("a");
  link.href = section.href;
  link.textContent = `Open ${section.label}`;
  card.append(link);
  return card;
}

function renderIconLibrary(library) {
  const section = document.createElement("section");
  section.className = "agentic-dashboard-card agentic-dashboard-region icon-library";
  section.setAttribute("aria-labelledby", "shared-icons-heading");
  const heading = document.createElement("h2");
  heading.id = "shared-icons-heading";
  heading.textContent = "Shared Icon Library";
  const list = document.createElement("ul");
  list.className = "agentic-dashboard-grid";
  list.dataset.columns = "4";
  list.setAttribute("aria-label", "Select a shared icon");
  const status = document.createElement("p");
  status.className = "icon-library-status";
  status.setAttribute("role", "status");
  status.textContent = "No icon selected.";

  for (const [name, nodes] of Object.entries(library.icons)) {
    const item = document.createElement("li");
    const card = document.createElement("article");
    card.className = "agentic-dashboard-card icon-library-item";
    card.setAttribute("aria-label", `${name} icon example`);
    const figure = document.createElement("figure");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agentic-toolbar-item agentic-icon-pill agentic-icon-hover";
    button.setAttribute("aria-label", `Toggle ${name} icon`);
    button.setAttribute("aria-pressed", "false");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [attribute, value] of Object.entries({
      viewBox: library.viewBox, fill: "none", stroke: "currentColor",
      "stroke-linecap": "round", "stroke-linejoin": "round",
      role: "img", "aria-label": `${name} icon`, class: "agentic-icon",
    })) icon.setAttribute(attribute, value);
    const title = document.createElementNS(icon.namespaceURI, "title");
    title.textContent = `${name} icon`;
    icon.append(title);
    for (const [tag, attributes] of nodes) {
      const node = document.createElementNS(icon.namespaceURI, tag);
      for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, value);
      icon.append(node);
    }
    const caption = document.createElement("figcaption");
    caption.textContent = name;
    button.append(icon);
    figure.append(button, caption);
    card.append(figure);
    item.append(card);
    list.append(item);
    button.addEventListener("click", () => {
      const selected = button.getAttribute("aria-pressed") !== "true";
      for (const candidate of list.querySelectorAll("button")) {
        candidate.setAttribute("aria-pressed", String(candidate === button && selected));
      }
      status.textContent = selected ? `${name} icon selected.` : "No icon selected.";
    });
  }
  const divider = document.createElement("hr");
  divider.setAttribute("data-dashboard-primitive", "divider");
  section.append(heading, list, divider, status);
  return section;
}

function renderCatalog(query = "") {
  if (!registryContext) return;
  let result;
  try {
    result = searchRegistry(registryContext.catalog, [...registryContext.profiles.values()], query);
  } catch (error) {
    grid.replaceChildren();
    empty.hidden = false;
    empty.textContent = error instanceof Error ? error.message : "Search query is invalid.";
    searchStatus.textContent = "Search stopped because its query is outside the local registry contract.";
    return;
  }
  grid.replaceChildren();
  for (const row of result.results) {
    if (row.kind === "owner") grid.append(renderOwner(row));
    else if (row.kind === "profile") grid.append(renderProfile(row, Boolean(query.trim())));
    else if (row.kind === "record") grid.append(renderRecord(row));
    else if (row.kind === "section") grid.append(renderSection(row));
  }
  const count = result.results.length;
  empty.hidden = count > 0;
  empty.textContent = query.trim() ? "No owner, section, scope, profile, token key, or cleared record matches that search." : "No public catalog records are cleared yet.";
  const ownerCount = result.results.filter(row => row.kind === "owner").length;
  const profileRows = result.results.filter(row => row.kind === "profile");
  const tokenCount = profileRows.reduce((total, profile) => total + profile.tokens.length, 0);
  const recordCount = result.results.filter(row => row.kind === "record").length;
  searchStatus.textContent = `${ownerCount} repository owners · ${profileRows.length} profiles · ${tokenCount} matching candidate keys · ${recordCount} public records.`;
}

function renderNavigation(catalog, profiles) {
  const routes = searchRegistry(catalog, profiles, "/").results.filter(row => row.kind === "section");
  catalogNavigation.replaceChildren();
  for (const route of routes) {
    const link = document.createElement("a");
    link.className = "agentic-toolbar-item";
    link.href = route.href;
    link.textContent = route.label;
    catalogNavigation.append(link);
  }
  updateSectionSelection();
}

function updateSectionSelection() {
  for (const link of catalogNavigation.querySelectorAll("a")) {
    const selected = link.hash === location.hash;
    if (selected) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", updateSectionSelection);

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function loadRegistry() {
  const response = await fetch(catalogUrl, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  const catalog = await response.json();
  assertCatalog(catalog);
  if (!crypto.subtle) throw new Error("Pinned profile digests cannot be checked in this browser");
  const profiles = await Promise.all(catalog.registry.profiles.map(async manifest => {
    const profileResponse = await fetch(new URL(manifest.source, catalogUrl), { cache: "no-cache" });
    if (!profileResponse.ok) throw new Error(`Profile request failed: ${profileResponse.status}`);
    const bytes = await profileResponse.arrayBuffer();
    if (await sha256(bytes) !== manifest.digest) throw new Error(`${manifest.id} profile digest does not match its pin`);
    return JSON.parse(new TextDecoder().decode(bytes));
  }));
  registryContext = validateRegistryContext(catalog, profiles);
  renderNavigation(catalog, profiles);
  const profileCount = catalog.registry.profiles.length;
  const tokenCount = profiles.reduce((total, profile) => total + profile.tokens.length, 0);
  document.querySelector("#release-summary").textContent = `${catalog.registry.owners.length} source owners · ${profileCount} pinned candidate profiles · ${tokenCount} globally unique keys/variables · draft catalog; no consumer migrations claimed.`;
  renderCatalog(search.value);
  const iconResponse = await fetch(new URL(catalog.iconLibrary.path, catalogUrl), { cache: "no-cache" });
  if (!iconResponse.ok) throw new Error("Central icon library is unavailable");
  const iconBytes = await iconResponse.arrayBuffer();
  if (await sha256(iconBytes) !== catalog.iconLibrary.digest) throw new Error("Central icon digest mismatch");
  const library = JSON.parse(new TextDecoder().decode(iconBytes));
  sectionIndex.after(renderIconLibrary(library));
  sectionIndex.hidden = false;
  sectionIndex.removeAttribute("aria-busy");
  revealLateContent();
  try {
    const tools = await registerWebMcpTools(document.modelContext, registryContext);
    toolStatus.textContent = tools.supported
      ? "Read-only browser tools are available to compatible agents."
      : "Compatible browser tools are unavailable here; local search remains available.";
  } catch {
    toolStatus.textContent = "Browser tool registration failed; local search remains available.";
  }
}

search.addEventListener("input", () => renderCatalog(search.value));
loadRegistry().catch(error => {
  sectionIndex.hidden = false;
  sectionIndex.removeAttribute("aria-busy");
  revealLateContent();
  document.querySelector("#release-summary").textContent = "Ownership map unavailable or a pinned profile failed validation.";
  empty.hidden = false;
  empty.textContent = error instanceof Error ? error.message : "The local registry failed validation.";
  searchStatus.textContent = "The local registry did not satisfy its ownership, digest, or singleton contract.";
});

async function prepareOfflineRegistry() {
  const registration = await navigator.serviceWorker.register("./sw.js?v=registry-semantic-cards-3", {
    scope: "./", updateViaCache: "none",
  });
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw new Error("Offline cache has no registered worker");
  await new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", check);
      if (worker.state === "activated") resolve();
      else reject(new Error("Offline cache installation failed"));
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  prepareOfflineRegistry()
    .then(() => { offlineStatus.textContent = "Offline cache is ready for this site."; })
    .catch(() => { offlineStatus.textContent = "Offline caching is unavailable in this browser."; });
}
