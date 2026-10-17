/**
 * The Electron main process -- the only process that can reach the disk.
 *
 * The window gets a narrow bridge and nothing else: `contextIsolation` on,
 * `nodeIntegration` off, `sandbox` on. It never handles a path it could act
 * on. A folder picked in the native dialog is kept here and the window gets
 * an id for it; findings are addressed by scan id and item id; deletion is
 * confirmed by a native dialog this process draws, not one the page draws.
 *
 * Borrowed from disk-janitor's main process, minus everything that talked to
 * a model. Nothing here touches the network.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { listDrives, redact } from "../src/roots.js";
import { formatBytes, scan, SCAN_LIMITS } from "../src/scan.js";
import { describeSkips } from "../src/skips.js";
import { describeStacks, KINDS } from "../src/stacks.js";
import { gitAvailable } from "../src/git.js";
import { describeRemoval, describeScope, reverify, selectRemovable } from "../src/removal.js";
import { describeEraseError, eraseItem } from "../src/erase.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RENDERER = join(HERE, "..", "app", "index.html");

/** Local files only; a cached stylesheet from an older build is a wrong one. */
app.commandLine.appendSwitch("disable-http-cache");

/** Scans live in memory only, and only long enough to be reviewed. */
const scans = new Map();
const MAX_SCANS = 6;

/** Folders picked in the native dialog, by id. The window never sees these paths as input. */
const picked = new Map();

function rememberScan(result, roots) {
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  scans.set(id, { ...result, roots, id, createdAt: Date.now() });
  while (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value);
  return id;
}

/** In-flight scans and deletes, so Stop can stop one. */
const running = new Map();

/**
 * Turn off Electron's asar support while touching somebody else's disk.
 *
 * Electron patches Node's `fs` so a `.asar` file reads as a folder -- and it
 * keeps that file open to do so. Every Electron project has one in
 * `node_modules\electron\dist\resources\default_app.asar`; with the patch on,
 * the scan measured it as a folder and `rm` then waited forever on the lock
 * this very process held. With it off, an `.asar` is just a file.
 */
let asarOff = 0;
async function withoutAsar(fn) {
  if (asarOff++ === 0) process.noAsar = true;
  try {
    return await fn();
  } finally {
    if (--asarOff === 0) process.noAsar = false;
  }
}

// ── the bridge ──────────────────────────────────────────────────────────────

ipcMain.handle("jc:meta", async () => ({
  platform: "windows",
  git: await gitAvailable(),
  kinds: Object.values(KINDS),
  stacks: describeStacks(),
  skips: describeSkips(),
  limits: SCAN_LIMITS,
}));

ipcMain.handle("jc:drives", async () => ({ drives: await listDrives() }));

ipcMain.handle("jc:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose a folder to scan",
    properties: ["openDirectory", "dontAddToRecent"],
  });
  if (canceled || !filePaths?.[0]) return null;
  const path = filePaths[0];
  const id = `f${picked.size + 1}${Math.random().toString(36).slice(2, 6)}`;
  picked.set(id, path);
  return { id, label: path.split(/[\\/]/).filter(Boolean).pop() ?? path, path: redact(path) };
});

ipcMain.handle("jc:scan", async (event, { targets = [], includeRuntime = true, runId = "scan" } = {}) => {
  // Drive ids are re-enumerated here rather than trusted from the window, so
  // an id can only ever resolve to something actually mounted.
  const drives = targets.some((id) => String(id).startsWith("drive-")) ? await listDrives() : [];
  const resolved = [];
  for (const id of targets) {
    const drive = drives.find((candidate) => candidate.id === id);
    if (drive) resolved.push({ id, path: drive.path, label: drive.label });
    else if (picked.has(id)) resolved.push({ id, path: picked.get(id), label: picked.get(id) });
  }
  if (!resolved.length) throw new Error("Nothing to scan. Pick a folder or a drive first.");

  const controller = new AbortController();
  running.set(runId, controller);
  try {
    const result = await withoutAsar(() =>
      scan({
        targets: resolved,
        includeRuntime: Boolean(includeRuntime),
        signal: controller.signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send("jc:scan-progress", { runId, ...progress });
        },
      }),
    );
    const id = rememberScan(result, resolved.map((target) => target.path));
    return {
      scan: id,
      // Paths the window may display, never act on.
      items: result.items.map(({ path, repoPath, members, ...item }) => ({
        ...item,
        memberCount: members?.length ?? null,
        memberSample: members?.slice(0, 40).map(redact) ?? null,
      })),
      projects: result.projects,
      skipped: result.skipped,
      unreadable: result.unreadable,
      stats: result.stats,
      targets: resolved.map((target) => ({ id: target.id, path: redact(target.path) })),
    };
  } finally {
    running.delete(runId);
  }
});

ipcMain.handle("jc:cancel", (_event, runId) => {
  running.get(runId)?.abort();
  return true;
});

/**
 * Removal. The one place in this project that changes anything on disk.
 *
 *   ids       the window names `i7`, never a path
 *   refuse    blocked rows are refused here, whatever the window drew
 *   confirm   a native dialog, Cancel by default, "cannot be undone" up front
 *   reverify  each item is checked against the disk again right before `rm`
 */
ipcMain.handle("jc:remove", async (event, { scan: scanId, items: ids, runId = "remove" } = {}) => {
  const stored = scans.get(scanId);
  if (!stored) throw new Error("This scan has expired. Run a new scan first.");

  const { removable, refused } = selectRemovable(stored.items, ids ?? []);
  if (!removable.length) return { confirmed: false, removed: 0, bytes: 0, refused, reason: "nothing eligible" };

  const summary = describeRemoval(removable);
  const names = removable.slice(0, 8).map((item) => `  ${describeScope(item)}  (${formatBytes(item.bytes)})`);
  if (removable.length > names.length) names.push(`  …and ${removable.length - names.length} more`);

  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Cancel", "Delete Permanently"],
    defaultId: 0,
    cancelId: 0,
    title: "Delete permanently",
    message: `Permanently delete ${summary.count} folder${summary.count === 1 ? "" : "s"}?`,
    detail: [
      `${formatBytes(summary.bytes)} in total. This does not go to the Recycle Bin — it cannot be undone.`,
      ...(summary.warnings.length ? ["", ...summary.warnings] : []),
      "",
      ...names,
    ].join("\n"),
    noLink: true,
  });
  if (response !== 1) return { confirmed: false, removed: 0, bytes: 0, refused, reason: "cancelled" };

  const post = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send("jc:remove-progress", { runId, ...payload });
  };

  let removed = 0;
  let bytes = 0;
  const failures = [];
  const controller = new AbortController();
  running.set(runId, controller);

  try {
    await withoutAsar(async () => {
      for (const [index, item] of removable.entries()) {
        const step = { id: item.id, index: index + 1, total: removable.length };
        if (controller.signal.aborted) {
          post({ ...step, state: "skipped" });
          continue;
        }
        post({ ...step, state: "working", done: 0, of: 0 });
        // Progress a few times a second, not once per file.
        let lastPost = 0;
        const onProgress = (done, of) => {
          const now = Date.now();
          if (done !== of && now - lastPost < 120) return;
          lastPost = now;
          post({ ...step, state: "working", done, of });
        };
        try {
          const problem = await reverify(item, stored.roots);
          if (problem) throw new Error(`Not deleted — ${problem}.`);
          const done = await eraseItem(item, { onProgress, signal: controller.signal });
          removed += 1;
          bytes += item.bytes;
          // Dropped from the stored scan so a repeated request cannot ask again.
          stored.items = stored.items.filter((candidate) => candidate.id !== item.id);
          post({ ...step, state: "gone", bytes: item.bytes, detail: done.kind === "members" ? `${done.removed} folders` : null });
        } catch (error) {
          const message = error?.code ? describeEraseError(error) : (error?.message ?? String(error));
          failures.push({ id: item.id, name: item.relPath, error: message });
          post({ ...step, state: error?.stopped ? "stopped" : "failed", error: message });
        }
      }
    });
  } finally {
    running.delete(runId);
  }

  return { confirmed: true, removed, bytes, failures, refused, stopped: controller.signal.aborted };
});

/** Show a finding in Explorer. Addressed by id, like everything else. */
ipcMain.handle("jc:reveal", (_event, { scan: scanId, item: itemId } = {}) => {
  const item = scans.get(scanId)?.items.find((candidate) => candidate.id === itemId);
  if (!item) return false;
  if (item.type === "set") shell.openPath(item.path);
  else shell.showItemInFolder(item.path);
  return true;
});

ipcMain.handle("jc:theme", (event, source) => {
  if (!["system", "light", "dark"].includes(source)) source = "system";
  nativeTheme.themeSource = source;
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.setTitleBarOverlay(captionOverlay());
  return { source, dark: nativeTheme.shouldUseDarkColors };
});

// ── the window ──────────────────────────────────────────────────────────────

/** The Windows caption buttons, drawn over our own toolbar. */
const captionOverlay = () => ({
  color: "#00000000",
  symbolColor: nativeTheme.shouldUseDarkColors ? "#d0d0d0" : "#404040",
  height: 52,
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "StackSweep",
    titleBarStyle: "hidden",
    titleBarOverlay: captionOverlay(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f2f2f7",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Show on whichever signal arrives first, and regardless after a beat: an
  // unhappy GPU process can swallow `ready-to-show` entirely.
  const reveal = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  const fallback = setTimeout(reveal, 3000);
  win.once("closed", () => clearTimeout(fallback));
  win.loadFile(RENDERER).then(reveal, (error) => {
    console.error("The window failed to load its page:", error);
    reveal();
  });

  // Nothing in this app navigates anywhere.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (navigation) => navigation.preventDefault());

  nativeTheme.on("updated", () => {
    if (win.isDestroyed()) return;
    win.webContents.send("jc:theme", { dark: nativeTheme.shouldUseDarkColors });
    win.setTitleBarOverlay(captionOverlay());
  });

  return win;
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
