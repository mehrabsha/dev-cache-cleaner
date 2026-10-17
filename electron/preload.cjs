/**
 * The bridge, and the whole of it.
 *
 * CommonJS on purpose: a sandboxed preload can only `require("electron")`,
 * and an ESM preload would force `sandbox: false`.
 *
 * The window gets these named calls and nothing else -- no `require`, no
 * `fs`, no `ipcRenderer`. Folders are addressed by the id the native picker
 * handed back, findings by scan id and item id. No call takes a path.
 */

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("cleaner", {
  platform: process.platform,

  /** Stacks, kinds, skip rules, limits, whether git is installed. */
  meta: () => ipcRenderer.invoke("jc:meta"),

  /** What is mounted, with capacity and free space. */
  drives: () => ipcRenderer.invoke("jc:drives"),

  /** The native folder dialog. Returns `{ id, label, path }` or null. */
  pickFolder: () => ipcRenderer.invoke("jc:pick-folder"),

  /** Walk, measure, ask git. Reads only. */
  scan: (options) => ipcRenderer.invoke("jc:scan", options),
  cancel: (runId) => ipcRenderer.invoke("jc:cancel", runId),
  onScanProgress: (handler) => on("jc:scan-progress", handler),

  /** Permanently delete ticked findings, after a native confirmation. */
  remove: (options) => ipcRenderer.invoke("jc:remove", options),
  onRemoveProgress: (handler) => on("jc:remove-progress", handler),

  /** Open a finding in Explorer. */
  reveal: (scan, item) => ipcRenderer.invoke("jc:reveal", { scan, item }),

  /** "system" | "light" | "dark". */
  setTheme: (source) => ipcRenderer.invoke("jc:theme", source),
  onTheme: (handler) => on("jc:theme", handler),
});
