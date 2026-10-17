/**
 * The window.
 *
 * Three views — choose where to look, watch the walk, read the result — and
 * one rule for a row: it answers *what is this, how big is it, and can it go*.
 * The evidence behind the answer (which manifest claimed it, which marker is
 * inside, which .gitignore line ignores it, how many files are committed)
 * waits in the inspector until asked for.
 *
 * Talks to the main process through `window.cleaner` and nothing else. It
 * never holds a path it could act on: folders are ids from the native picker,
 * findings are ids in a scan.
 */

const api = window.cleaner;

const state = {
  meta: null,
  drives: [],
  folders: [],
  selectedDrives: new Set(),
  includeRuntime: true,
  scan: null,
  items: [],
  projects: [],
  /** Tier filter: actionable | safe | review | blocked | all */
  filter: "actionable",
  /** Second sidebar section: project | kind */
  group: "project",
  /** A project id or kind id narrowing the list, or null. */
  focus: null,
  selected: new Set(),
  removed: new Set(),
  removing: false,
  /** The delete in progress: which item, how far through it, when it last moved. */
  removal: null,
  reclaimed: 0,
  runId: null,
  logged: new Set(),
  theme: "system",
};

// ── formatting ──────────────────────────────────────────────────────────────

const UNITS = ["B", "KB", "MB", "GB", "TB"];

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const index = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${UNITS[index]}`;
}

function ago(days) {
  if (days == null) return "unknown";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")} years ago`;
}

const plural = (count, one, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

// ── tiny DOM helpers ────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function glyph(path, size = 12) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = path;
  return svg;
}

const GLYPHS = {
  check: '<path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  cross: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  dot: '<circle cx="8" cy="8" r="2.4" fill="currentColor"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.8 7V5.3a2.2 2.2 0 0 1 4.4 0V7" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  folder: '<path d="M2 5.2c0-.7.5-1.2 1.2-1.2h2.4l1.3 1.6h5.9c.7 0 1.2.5 1.2 1.2v4.8c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2Z"/>',
  stack: '<path d="M2.5 5.5 8 2.8l5.5 2.7L8 8.2Z"/><path d="m2.5 8.5 5.5 2.7 5.5-2.7"/><path d="m2.5 11 5.5 2.7L13.5 11"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  drive: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.4 8.6h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="11.4" cy="8.6" r="1" fill="currentColor"/>',
  info: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4M8 5.1v.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  clock: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

/** Everything the UI needs to know about a tier, in one place. */
const TIERS = {
  safe: {
    label: "Safe to delete",
    short: "Safe",
    color: "var(--verdict-safe)",
    glyph: GLYPHS.check,
    hint: "Owned by the project's stack, ignored by git, nothing committed inside.",
  },
  review: {
    label: "Review first",
    short: "Review",
    color: "var(--verdict-review)",
    glyph: GLYPHS.eye,
    hint: "Probably regenerable, or runtime data that is not — look before you tick.",
  },
  blocked: {
    label: "Blocked",
    short: "Blocked",
    color: "var(--verdict-protected)",
    glyph: GLYPHS.lock,
    hint: "Committed files inside, or no project owns it. Shown so you know, never deletable here.",
  },
};

const FILTERS = [
  { id: "actionable", label: "Safe and review", tiers: ["safe", "review"], color: "var(--accent)" },
  { id: "safe", label: TIERS.safe.label, tiers: ["safe"], color: TIERS.safe.color },
  { id: "review", label: TIERS.review.label, tiers: ["review"], color: TIERS.review.color },
  { id: "blocked", label: TIERS.blocked.label, tiers: ["blocked"], color: TIERS.blocked.color },
];

function badge(tier) {
  const spec = TIERS[tier] ?? TIERS.blocked;
  const node = el("span", "badge");
  node.dataset.tier = tier;
  node.append(glyph(spec.glyph, 11), el("span", null, spec.short));
  return node;
}

function titleOf(item) {
  if (!item.project) return item.relPath;
  return `${item.project.name} › ${item.relPath}`;
}

function scopeOf(item) {
  if (item.type === "set") {
    return `${plural(item.memberCount ?? 0, `“${item.artifactName}” folder`)} scattered through this project — each one removed by name. The project folder itself is not touched.`;
  }
  return `This folder and everything inside it — ${plural(item.files, "file")} across ${plural(item.dirs, "subfolder")}. Deleting removes all of it.`;
}

// ── shell ───────────────────────────────────────────────────────────────────

const view = (name) => {
  document.body.dataset.view = name;
};

const status = (text) => {
  document.getElementById("status-left").textContent = text;
};

function banner(message) {
  const node = el("div", "banner");
  node.append(glyph(GLYPHS.info, 15), el("span", null, message));
  return node;
}

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  document.documentElement.dataset.platform = api?.platform ?? "web";
  let saved = "system";
  try {
    saved = localStorage.getItem("cleaner.theme") ?? "system";
  } catch {
    /* storage unavailable; Auto is a fine answer */
  }
  applyTheme(saved);

  if (!api) {
    document.getElementById("view-setup").prepend(banner("Open this through the app (npm start) — a plain browser cannot reach the disk."));
    return;
  }

  try {
    state.meta = await api.meta();
    const { drives } = await api.drives();
    state.drives = drives;
  } catch (error) {
    document.getElementById("view-setup").prepend(banner(error.message ?? String(error)));
  }

  if (state.meta && !state.meta.git) {
    document.getElementById("view-setup").prepend(
      banner("git was not found on PATH. Committed files cannot be checked, so most findings will be marked Review instead of Safe."),
    );
  }

  try {
    state.includeRuntime = localStorage.getItem("cleaner.runtime") !== "off";
  } catch {
    /* default stays on */
  }

  renderFolders();
  renderDrives();
  renderOptions();
  updateScanNote();
  status("Ready");
  wire();
}

// ── setup ───────────────────────────────────────────────────────────────────

function toggleRow(title, subtitle, checked, onChange) {
  const row = el("li", "row");
  const body = el("div", "row-body");
  body.append(el("span", "row-title", title), el("span", "row-sub", subtitle));

  const control = el("button", "switch");
  control.type = "button";
  control.setAttribute("role", "switch");
  control.setAttribute("aria-checked", String(checked));
  control.setAttribute("aria-label", title);

  const flip = () => {
    const next = control.getAttribute("aria-checked") !== "true";
    control.setAttribute("aria-checked", String(next));
    onChange(next);
    updateScanNote();
  };
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    flip();
  });
  row.addEventListener("click", flip);
  row.append(body, control);
  return row;
}

function renderFolders() {
  const list = document.getElementById("folders");
  list.replaceChildren();
  if (!state.folders.length) {
    const empty = el("li", "row placeholder");
    const body = el("div", "row-body");
    body.append(
      el("span", "row-title", "No folder chosen"),
      el("span", "row-sub", "Choose a folder that holds your projects — a code folder, a client folder, a whole workspace."),
    );
    const button = el("button", "button", "Choose folder…");
    button.type = "button";
    button.addEventListener("click", addFolder);
    empty.append(body, button);
    list.append(empty);
    return;
  }

  for (const folder of state.folders) {
    const row = el("li", "row");
    const body = el("div", "row-body");
    body.append(el("span", "row-title", folder.label), el("span", "row-sub mono", folder.path));
    const remove = el("button", "link-button", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      state.folders = state.folders.filter((candidate) => candidate.id !== folder.id);
      renderFolders();
      updateScanNote();
    });
    row.append(body, remove);
    list.append(row);
  }
}

async function addFolder() {
  const folder = await api.pickFolder();
  if (!folder) return;
  if (!state.folders.some((candidate) => candidate.path === folder.path)) state.folders.push(folder);
  renderFolders();
  updateScanNote();
}

function renderDrives() {
  const panel = document.getElementById("drives-panel");
  const list = document.getElementById("drives");
  list.replaceChildren();
  panel.hidden = !state.drives.length;
  for (const drive of state.drives) {
    list.append(
      toggleRow(
        drive.label + (drive.system ? " — the system drive" : ""),
        `${bytes(drive.freeBytes)} free of ${bytes(drive.totalBytes)}`,
        state.selectedDrives.has(drive.id),
        (on) => (on ? state.selectedDrives.add(drive.id) : state.selectedDrives.delete(drive.id)),
      ),
    );
  }
}

function renderOptions() {
  const list = document.getElementById("options");
  list.replaceChildren(
    toggleRow(
      "Include runtime data",
      "Large gitignored uploads, logs and temp folders inside projects. Listed as Review, never pre-selected — they do not come back.",
      state.includeRuntime,
      (on) => {
        state.includeRuntime = on;
        try {
          localStorage.setItem("cleaner.runtime", on ? "on" : "off");
        } catch {
          /* not persisted */
        }
      },
    ),
  );
}

function updateScanNote() {
  const parts = [];
  if (state.folders.length) parts.push(plural(state.folders.length, "folder"));
  if (state.selectedDrives.size) parts.push(plural(state.selectedDrives.size, "drive"));
  const nothing = parts.length === 0;
  document.getElementById("scan").disabled = nothing;
  document.getElementById("scan-note").textContent = nothing
    ? "Choose a folder or tick a drive."
    : `${parts.join(" and ")} · this step only reads.`;
}

function applyTheme(source) {
  state.theme = ["system", "light", "dark"].includes(source) ? source : "system";
  if (state.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  for (const button of document.querySelectorAll("#theme button")) {
    button.setAttribute("aria-checked", String(button.dataset.theme === state.theme));
  }
  try {
    localStorage.setItem("cleaner.theme", state.theme);
  } catch {
    /* not persisted */
  }
  api?.setTheme?.(state.theme);
}

// ── working ─────────────────────────────────────────────────────────────────

const LOG_TONES = {
  walking: "var(--verdict-keep)",
  done: "var(--verdict-safe)",
  warn: "var(--verdict-review)",
  quiet: "var(--text-tertiary)",
};
const LOG_LIMIT = 160;

function resetWork() {
  document.getElementById("work-phase").textContent = "Walking";
  document.getElementById("working-title").textContent = "Looking for projects";
  document.getElementById("work-log").replaceChildren();
  document.getElementById("work-stats").replaceChildren();
  document.getElementById("work-log-note").textContent = "";
  document.getElementById("work-left").textContent = "Starting…";
  document.getElementById("work-right").textContent = "";
  document.getElementById("work-bar").classList.add("indeterminate");
  state.logged = new Set();
}

function workStats(entries) {
  const host = document.getElementById("work-stats");
  if (host.childElementCount !== entries.length) host.replaceChildren();
  entries.forEach((entry, index) => {
    let tile = host.children[index];
    if (!tile) {
      tile = el("div", "work-stat");
      tile.append(el("div", "work-stat-value"), el("div", "work-stat-label"));
      host.append(tile);
    }
    tile.firstChild.textContent = entry.value;
    tile.lastChild.textContent = entry.label;
  });
}

function log(text, { tone = "quiet", meta = "", strong = "", key } = {}) {
  if (key) {
    if (state.logged.has(key)) return;
    state.logged.add(key);
  }
  const list = document.getElementById("work-log");
  const row = el("li");
  const dot = el("span", "work-log-dot");
  dot.style.setProperty("--tone", LOG_TONES[tone] ?? LOG_TONES.quiet);
  const body = el("span", "work-log-text");
  if (strong) body.append(el("strong", null, strong), document.createTextNode(` ${text}`));
  else body.textContent = text;
  row.append(dot, body, el("span", "work-log-meta", meta));
  list.prepend(row);
  while (list.childElementCount > LOG_LIMIT) list.lastChild.remove();
  document.getElementById("work-log-note").textContent = plural(list.childElementCount, "line");
}

const PHASES = {
  walk: { label: "Walking", title: "Looking for projects" },
  measure: { label: "Measuring", title: "Measuring what was found" },
  git: { label: "Checking git", title: "Asking git what is committed and ignored" },
  done: { label: "Done", title: "Finishing up" },
};

async function runScan() {
  view("working");
  resetWork();
  document.getElementById("stop").hidden = false;
  document.getElementById("rescan").hidden = true;
  document.getElementById("grouping").hidden = true;
  document.getElementById("inspector").hidden = true;
  status("Scanning…");

  const targets = [...state.folders.map((folder) => folder.id), ...state.selectedDrives];
  state.runId = `scan-${Date.now()}`;
  log("Scan started", { tone: "walking", meta: plural(targets.length, "place") });

  try {
    const result = await api.scan({ targets, includeRuntime: state.includeRuntime, runId: state.runId });
    state.scan = result;
    state.items = result.items;
    state.projects = result.projects;
    state.selected.clear();
    state.removed.clear();
    state.focus = null;
    state.filter = "actionable";
    showResults();
  } catch (error) {
    log(error.message ?? String(error), { tone: "warn" });
    status(error.message ?? "The scan failed.");
    document.getElementById("rescan").hidden = false;
  } finally {
    document.getElementById("stop").hidden = true;
    state.runId = null;
  }
}

function onScanProgress(progress) {
  if (progress.runId !== state.runId) return;
  const phase = PHASES[progress.phase] ?? PHASES.walk;
  document.getElementById("work-phase").textContent = phase.label;
  document.getElementById("working-title").textContent = phase.title;
  log(phase.label, { tone: "walking", key: `phase:${progress.phase}`, meta: `${(progress.elapsedMs / 1000).toFixed(1)}s` });

  document.getElementById("work-left").textContent = progress.current || "…";
  document.getElementById("work-right").textContent = `${(progress.elapsedMs / 1000).toFixed(1)}s`;

  const bar = document.getElementById("work-bar");
  if (progress.phase === "measure" && progress.candidates) {
    bar.classList.remove("indeterminate");
    document.getElementById("work-bar-fill").style.width = `${Math.min(100, (progress.measured / progress.candidates) * 100)}%`;
  } else {
    bar.classList.add("indeterminate");
  }

  workStats([
    { value: progress.dirs.toLocaleString(), label: "folders read" },
    { value: progress.projects.toLocaleString(), label: "projects found" },
    { value: progress.candidates.toLocaleString(), label: "candidates" },
    { value: bytes(progress.measuredBytes), label: "measured" },
  ]);

  for (const found of progress.recent ?? []) {
    log(`in ${found.project}`, { strong: found.name, tone: "done", meta: found.stack });
  }
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults() {
  view("results");
  document.getElementById("rescan").hidden = false;
  document.getElementById("grouping").hidden = false;
  renderSidebar();
  renderOverview();
  renderList();
  renderRemovalBar();
  renderStatusRight();

  const { stats } = state.scan;
  const cut = stats.stoppedBy === "cancelled" ? " · stopped early, results are partial" : stats.stoppedBy ? " · hit a limit, results are partial" : "";
  status(`${plural(stats.dirs, "folder")} read in ${(stats.elapsedMs / 1000).toFixed(1)}s · ${plural(stats.projectsSeen, "project")}${cut}`);
}

const live = () => state.items.filter((item) => !state.removed.has(item.id));

function itemsFor({ filter = state.filter, focus = state.focus } = {}) {
  const tiers = FILTERS.find((entry) => entry.id === filter)?.tiers ?? ["safe", "review", "blocked"];
  return live().filter((item) => {
    if (!tiers.includes(item.tier)) return false;
    if (!focus) return true;
    if (focus.startsWith("kind:")) return item.kind === focus.slice(5);
    return item.project?.id === focus;
  });
}

function navItem(label, count, current, swatch, onClick, title) {
  const button = el("button", "nav-item");
  button.type = "button";
  button.setAttribute("aria-current", String(current));
  if (title) button.title = title;
  // A swatch only where it carries a colour (the tiers). An empty grey square
  // beside every project name reads as an unticked checkbox.
  if (swatch) {
    const dot = el("span", "nav-swatch");
    dot.style.setProperty("--swatch", swatch);
    button.append(dot);
  }
  button.append(el("span", "nav-label", label), el("span", "nav-count", count));
  button.addEventListener("click", onClick);
  return button;
}

function renderSidebar() {
  document.getElementById("sidebar-empty").hidden = true;
  const host = document.getElementById("sidebar-groups");
  host.hidden = false;
  host.replaceChildren();

  const show = el("div", "sidebar-section");
  show.append(el("div", "sidebar-heading", "Show"));
  for (const filter of FILTERS) {
    const matching = itemsFor({ filter: filter.id, focus: null });
    show.append(
      navItem(filter.label, bytes(matching.reduce((sum, item) => sum + item.bytes, 0)), state.filter === filter.id, filter.color, () => {
        state.filter = filter.id;
        renderSidebar();
        renderList();
      }),
    );
  }
  host.append(show);

  const group = el("div", "sidebar-section");
  const pool = itemsFor({ focus: null });
  if (state.group === "project") {
    group.append(el("div", "sidebar-heading", "Projects"));
    group.append(navItem("All projects", plural(pool.length, "item"), state.focus === null, null, () => focus(null)));
    const byProject = new Map();
    for (const item of pool) {
      const key = item.project?.id ?? "none";
      const entry = byProject.get(key) ?? { id: item.project?.id ?? null, name: item.project?.name ?? "Outside any project", dir: item.project?.displayDir, bytes: 0 };
      entry.bytes += item.bytes;
      byProject.set(key, entry);
    }
    for (const entry of [...byProject.values()].sort((a, b) => b.bytes - a.bytes)) {
      if (!entry.id) continue;
      group.append(navItem(entry.name, bytes(entry.bytes), state.focus === entry.id, null, () => focus(entry.id), entry.dir));
    }
  } else {
    group.append(el("div", "sidebar-heading", "Kinds"));
    group.append(navItem("All kinds", plural(pool.length, "item"), state.focus === null, null, () => focus(null)));
    const byKind = new Map();
    for (const item of pool) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + item.bytes);
    for (const kind of state.meta?.kinds ?? []) {
      if (!byKind.has(kind.id)) continue;
      group.append(navItem(kind.label, bytes(byKind.get(kind.id)), state.focus === `kind:${kind.id}`, null, () => focus(`kind:${kind.id}`), kind.blurb));
    }
  }
  host.append(group);
}

function focus(id) {
  state.focus = id;
  renderSidebar();
  renderList();
}

function renderOverview() {
  const host = document.getElementById("overview");
  host.replaceChildren();
  const items = live();

  const tiles = el("div", "tiles");
  for (const tier of ["safe", "review", "blocked"]) {
    const matching = items.filter((item) => item.tier === tier);
    const tile = el("div", "tile");
    const label = el("div", "tile-label");
    const dot = el("span", "tile-dot");
    dot.style.setProperty("--swatch", TIERS[tier].color);
    label.append(dot, el("span", null, TIERS[tier].label));
    tile.append(
      label,
      el("div", `tile-value${tier === "safe" ? " hero-figure" : ""}`, bytes(matching.reduce((sum, item) => sum + item.bytes, 0))),
      el("div", "tile-note", `${plural(matching.length, "folder")} · ${TIERS[tier].hint}`),
    );
    tiles.append(tile);
  }
  host.append(tiles);

  if (state.reclaimed) host.append(banner(`${bytes(state.reclaimed)} freed so far in this session.`));

  const { skipped, unreadable, stats } = state.scan;
  if (skipped.length || unreadable.length || !stats.git) {
    const details = el("details", "disclosure skipped");
    const total = skipped.reduce((sum, rule) => sum + rule.count, 0);
    details.append(el("summary", null, `Not looked inside — ${plural(total, "folder")} declined${unreadable.length ? `, ${plural(unreadable.length, "unreadable")}` : ""}`));
    const body = el("ul", "evidence disclosure-body");
    for (const rule of skipped) {
      const row = el("li");
      row.append(glyph(GLYPHS.lock, 13), el("span", null, `${rule.count.toLocaleString()} × ${rule.why}  e.g. ${rule.example}`));
      body.append(row);
    }
    for (const entry of unreadable.slice(0, 12)) {
      const row = el("li");
      row.append(glyph(GLYPHS.cross, 13), el("span", null, `${entry.code} — ${entry.path}`));
      body.append(row);
    }
    details.append(body);
    host.append(details);
  }
}

function renderList() {
  const list = document.getElementById("items");
  list.replaceChildren();
  const entries = itemsFor();

  const filterLabel = FILTERS.find((entry) => entry.id === state.filter)?.label ?? "Findings";
  let scope = "";
  if (state.focus?.startsWith("kind:")) scope = state.meta?.kinds.find((kind) => `kind:${kind.id}` === state.focus)?.label ?? "";
  else if (state.focus) scope = state.projects.find((project) => project.id === state.focus)?.name ?? "";
  document.getElementById("list-title").textContent = scope ? `${scope} — ${filterLabel.toLowerCase()}` : filterLabel;
  document.getElementById("list-count").textContent = `${plural(entries.length, "folder")} · ${bytes(entries.reduce((sum, item) => sum + item.bytes, 0))}`;
  document.getElementById("select-safe").hidden = !entries.some((item) => item.tier === "safe");

  if (!entries.length) {
    list.append(el("li", "empty", state.items.length ? "Nothing here." : "Nothing to clean up was found."));
    return;
  }
  for (const item of entries) list.append(itemRow(item));
}

function itemRow(item) {
  const row = el("li", "row");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.dataset.id = item.id;
  row.dataset.tier = item.tier;

  // A blocked row gets a lock where the tick would be, not a disabled box --
  // a box of any kind reads as something to click. Main refuses it regardless.
  if (item.tier === "blocked") {
    const lock = el("span", "tick-void");
    lock.title = "Cannot be deleted from here";
    lock.append(glyph(GLYPHS.lock, 12));
    row.append(lock);
  } else {
    const tick = el("button", "tick");
    tick.type = "button";
    tick.setAttribute("role", "checkbox");
    tick.setAttribute("aria-checked", String(state.selected.has(item.id)));
    tick.setAttribute("aria-label", `Select ${titleOf(item)}`);
    tick.append(glyph(GLYPHS.check, 11));
    tick.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSelected(item.id);
    });
    row.append(tick);
  }

  // No folder icon beside the tick: every row is a folder, and a second
  // rounded square next to a checkbox looks like a second checkbox.
  const body = el("div", "row-body");
  const title = el("span", "row-title");
  if (item.project) {
    title.append(el("span", "row-project", item.project.name), el("span", "row-sep", " › "), document.createTextNode(item.relPath));
  } else {
    title.textContent = item.relPath;
  }
  const sub = el("span", "row-sub");
  sub.append(el("span", "row-scope", item.stack?.label ?? item.kindLabel), document.createTextNode(` · ${item.reason}`));
  if (item.project?.lastActiveDays != null && item.project.lastActiveDays <= 7) {
    const active = el("span", "row-active", ` · active ${ago(item.project.lastActiveDays)}`);
    sub.append(active);
  }
  body.append(title, sub);

  const size = el("span", "row-size", bytes(item.bytes));
  size.title = item.displayPath;

  row.append(body, size, badge(item.tier), glyph(GLYPHS.chevron, 11));
  row.lastChild.classList.add("chevron");

  const open = () => openInspector(item);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      open();
    } else if (event.key === " " && item.tier !== "blocked") {
      event.preventDefault();
      toggleSelected(item.id);
    }
  });
  return row;
}

// ── inspector ───────────────────────────────────────────────────────────────

function fact(label, value) {
  const node = el("div", "fact");
  node.append(el("div", "fact-label", label), el("div", "fact-value", value));
  return node;
}

function openInspector(item) {
  const panel = document.getElementById("inspector");
  const body = document.getElementById("inspector-body");
  body.replaceChildren();

  body.append(el("h2", null, titleOf(item)), el("div", "path", item.displayPath));

  const scope = el("div", "scope");
  scope.append(glyph(item.type === "set" ? GLYPHS.stack : GLYPHS.folder, 14), el("span", null, scopeOf(item)));
  body.append(scope);

  const verdict = el("div", "inspector-verdict");
  verdict.append(badge(item.tier));
  body.append(verdict, el("p", "inspector-reason", item.reason));

  const facts = el("div", "facts");
  facts.append(
    fact("Size", bytes(item.bytes) + (item.truncated ? " (at least)" : "")),
    fact("Files", item.files.toLocaleString()),
    fact("Last written", ago(item.ageDays)),
    fact("Project last active", item.project ? ago(item.project.lastActiveDays) : "—"),
    fact("Kind", item.kindLabel),
    fact("Stack", item.project?.stacks.join(", ") || "none detected"),
  );
  if (item.project) {
    facts.append(fact("Project folder", item.project.displayDir), fact("Package name", item.project.packageName ?? "—"));
  }
  body.append(facts);

  body.append(el("h3", "inspector-heading", "Why"));
  const evidence = el("ul", "evidence");
  for (const entry of item.evidence) {
    const row = el("li");
    row.dataset.ok = entry.ok === true ? "yes" : entry.ok === false ? "no" : "neutral";
    row.append(glyph(entry.ok === true ? GLYPHS.check : entry.ok === false ? GLYPHS.cross : GLYPHS.dot, 13), el("span", null, entry.text));
    evidence.append(row);
  }
  body.append(evidence);

  if (item.regen) {
    body.append(el("h3", "inspector-heading", "Bring it back with"));
    body.append(el("code", "cmd", item.regen));
  }

  if (item.type === "set" && item.memberSample?.length) {
    body.append(el("h3", "inspector-heading", `The ${plural(item.memberCount, "folder")}`));
    const members = el("ul", "member-list");
    for (const member of item.memberSample) members.append(el("li", null, member));
    if (item.memberCount > item.memberSample.length) members.append(el("li", "member-more", `…and ${item.memberCount - item.memberSample.length} more`));
    body.append(members);
  }

  const actions = el("div", "inspector-actions");
  const reveal = el("button", "button", "Show in Explorer");
  reveal.type = "button";
  reveal.addEventListener("click", () => api.reveal(state.scan.scan, item.id));
  actions.append(reveal);
  if (item.tier !== "blocked") {
    const pick = el("button", "button", state.selected.has(item.id) ? "Deselect" : "Select for deletion");
    pick.type = "button";
    pick.addEventListener("click", () => {
      toggleSelected(item.id);
      pick.textContent = state.selected.has(item.id) ? "Deselect" : "Select for deletion";
    });
    actions.append(pick);
  }
  body.append(actions);

  panel.hidden = false;
}

// ── removal ─────────────────────────────────────────────────────────────────

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const tick = document.querySelector(`#items .row[data-id="${id}"] .tick`);
  tick?.setAttribute("aria-checked", String(state.selected.has(id)));
  renderRemovalBar();
}

function renderRemovalBar() {
  const bar = document.getElementById("removal-bar");
  const deleting = Boolean(state.removal?.confirmed);
  document.getElementById("removal-clear").hidden = deleting;
  document.getElementById("removal-go").hidden = deleting;
  document.getElementById("removal-stop").hidden = !deleting;
  document.getElementById("removal-progress").hidden = !deleting;
  bar.classList.toggle("is-deleting", deleting);
  if (deleting) {
    bar.hidden = false;
    renderRemovalProgress();
    return;
  }

  const items = [...state.selected].map((id) => state.items.find((item) => item.id === id)).filter(Boolean);
  bar.hidden = items.length === 0 || state.removing;
  if (!items.length) return;

  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  const review = items.filter((item) => item.tier === "review").length;
  document.getElementById("removal-count").textContent = `${plural(items.length, "folder")} · ${bytes(total)}`;
  document.getElementById("removal-note").textContent = review
    ? `${review} of them ${review === 1 ? "is" : "are"} marked Review — the confirmation will say which.`
    : "Deleted for good — this does not go to the Recycle Bin.";
}

function renderStatusRight() {
  const safe = live().filter((item) => item.tier === "safe").reduce((sum, item) => sum + item.bytes, 0);
  document.getElementById("status-right").textContent = state.scan ? `${bytes(safe)} safe to reclaim` : "";
}

/** The row leaves, then the gap closes. Measured, so the collapse is exact. */
function animateRowOut(row) {
  if (!row) return;
  row.style.maxHeight = `${row.getBoundingClientRect().height}px`;
  row.classList.add("is-gone");
  setTimeout(() => row.classList.add("is-collapsing"), 190);
  setTimeout(() => row.remove(), 430);
}

/** Seconds without a single piece going before the bar says it is waiting. */
const STALL_SECONDS = 8;

const clock = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The bar while deleting: which folder, how far through it, how much is
 * freed, how long it has taken -- and, when nothing has moved for a few
 * seconds, that it is waiting rather than working. A frozen "Deleting 1 of 8"
 * with no way to tell stuck from slow is exactly what this replaces.
 */
function renderRemovalProgress() {
  const removal = state.removal;
  if (!removal?.confirmed) return;
  const item = state.items.find((candidate) => candidate.id === removal.id);
  const name = item ? titleOf(item) : "…";
  const within = removal.of ? removal.done / removal.of : 0;
  const overall = removal.total ? (removal.index - 1 + within) / removal.total : 0;
  const freed = removal.freed + (item ? item.bytes * within : 0);
  const now = Date.now();

  document.getElementById("removal-count").textContent = removal.stopping
    ? `Stopping after the current piece — ${name}`
    : `Deleting ${removal.index} of ${removal.total} — ${name}`;

  const stalled = (now - removal.lastChangeAt) / 1000 >= STALL_SECONDS;
  const note = document.getElementById("removal-note");
  note.classList.toggle("is-stalled", stalled);
  const pieces = removal.of ? `${removal.done.toLocaleString()} of ${removal.of.toLocaleString()} pieces` : "Checking it is still safe…";
  note.textContent = stalled
    ? `Waiting on a locked file for ${clock(now - removal.lastChangeAt)} — a dev server, IDE or emulator may have it open. Close it, or press Stop.`
    : `${pieces} · ${bytes(freed)} freed · ${clock(now - removal.startedAt)}`;

  const fill = document.getElementById("removal-progress-fill");
  fill.style.width = `${Math.min(100, overall * 100)}%`;
  document.getElementById("removal-progress").setAttribute("aria-valuenow", String(Math.round(overall * 100)));

  const row = document.querySelector(`#items .row[data-id="${removal.id}"]`);
  row?.style.setProperty("--progress", `${Math.round(within * 100)}%`);
}

async function runRemoval() {
  const chosen = [...state.selected];
  if (!chosen.length || state.removing) return;
  state.removing = true;
  const runId = `remove-${Date.now()}`;
  state.removal = { runId, confirmed: false, index: 0, total: chosen.length, id: null, done: 0, of: 0, freed: 0, startedAt: 0, lastChangeAt: 0 };
  renderRemovalBar();
  const ticker = setInterval(renderRemovalProgress, 500);

  try {
    const result = await api.remove({ scan: state.scan.scan, items: chosen, runId });
    if (!result.confirmed) {
      status(result.reason === "cancelled" ? "Nothing was deleted." : "Nothing eligible to delete.");
      return;
    }
    state.reclaimed += result.bytes;
    state.selected.clear();
    const failed = (result.failures ?? []).filter((failure) => !/^Stopped/.test(failure.error)).length;
    status(
      `${result.stopped ? "Stopped. " : ""}Deleted ${plural(result.removed, "folder")} · ${bytes(result.bytes)} freed` +
        (failed ? ` · ${failed} could not be deleted` : "") +
        (result.stopped ? " · scan again to see what is left" : ""),
    );
    setTimeout(() => {
      renderSidebar();
      renderOverview();
      renderList();
      renderStatusRight();
      // Rows that failed are rebuilt clean by renderList; say so where the eye is.
      for (const failure of result.failures ?? []) {
        const row = document.querySelector(`#items .row[data-id="${failure.id}"]`);
        if (!row) continue;
        row.classList.add("is-failed");
        const sub = row.querySelector(".row-sub");
        if (sub) sub.textContent = failure.error;
      }
    }, 520);
  } catch (error) {
    status(error.message ?? "Deleting failed.");
  } finally {
    clearInterval(ticker);
    state.removing = false;
    state.removal = null;
    renderRemovalBar();
  }
}

function onRemoveProgress(event) {
  const removal = state.removal;
  if (!removal || event.runId !== removal.runId) return;
  const row = document.querySelector(`#items .row[data-id="${event.id}"]`);
  const now = Date.now();

  if (event.state === "working") {
    if (!removal.confirmed) {
      removal.confirmed = true;
      removal.startedAt = now;
      renderRemovalBar();
    }
    if (removal.id !== event.id) {
      removal.id = event.id;
      removal.index = event.index;
      removal.total = event.total;
      removal.done = 0;
      removal.of = 0;
      removal.lastChangeAt = now;
      row?.classList.add("is-working");
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (event.done !== removal.done || event.of !== removal.of) {
      removal.done = event.done ?? 0;
      removal.of = event.of ?? 0;
      removal.lastChangeAt = now;
    }
    status(`Deleting ${event.index} of ${event.total}…`);
    renderRemovalProgress();
    return;
  }

  row?.classList.remove("is-working");
  if (event.state === "gone") {
    removal.freed += event.bytes ?? 0;
    removal.done = removal.of;
    state.removed.add(event.id);
    animateRowOut(row);
    renderRemovalProgress();
    return;
  }
  if (event.state === "failed" || event.state === "stopped") {
    row?.classList.add("is-failed");
    const sub = row?.querySelector(".row-sub");
    if (sub) sub.textContent = event.error;
    state.selected.delete(event.id);
  }
}

function stopRemoval() {
  if (!state.removal?.confirmed || state.removal.stopping) return;
  state.removal.stopping = true;
  api.cancel(state.removal.runId);
  renderRemovalProgress();
}

// ── wiring ──────────────────────────────────────────────────────────────────

function wire() {
  document.getElementById("scan").addEventListener("click", runScan);
  document.getElementById("add-folder").addEventListener("click", addFolder);

  document.getElementById("rescan").addEventListener("click", () => {
    view("setup");
    document.getElementById("rescan").hidden = true;
    document.getElementById("grouping").hidden = true;
    document.getElementById("inspector").hidden = true;
    document.getElementById("removal-bar").hidden = true;
    status("Ready");
  });

  document.getElementById("stop").addEventListener("click", () => {
    if (state.runId) api.cancel(state.runId);
    status("Stopping…");
  });

  for (const button of document.querySelectorAll("#theme button")) {
    button.addEventListener("click", () => applyTheme(button.dataset.theme));
  }

  for (const button of document.querySelectorAll("#grouping button")) {
    button.addEventListener("click", () => {
      state.group = button.dataset.group;
      state.focus = null;
      for (const sibling of document.querySelectorAll("#grouping button")) {
        sibling.setAttribute("aria-checked", String(sibling === button));
      }
      renderSidebar();
      renderList();
    });
  }

  document.getElementById("inspector-close").addEventListener("click", () => {
    document.getElementById("inspector").hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.getElementById("inspector").hidden = true;
  });

  document.getElementById("select-safe").addEventListener("click", () => {
    // The one batch worth a shortcut: Safe rows in the current view. Never Review.
    for (const item of itemsFor()) if (item.tier === "safe") state.selected.add(item.id);
    renderList();
    renderRemovalBar();
  });

  document.getElementById("removal-clear").addEventListener("click", () => {
    state.selected.clear();
    renderList();
    renderRemovalBar();
  });
  document.getElementById("removal-go").addEventListener("click", runRemoval);
  document.getElementById("removal-stop").addEventListener("click", stopRemoval);

  api.onScanProgress(onScanProgress);
  api.onRemoveProgress(onRemoveProgress);
}

boot();
