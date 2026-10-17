/**
 * A dry run from the terminal: `npm run scan -- <folder> [<folder>…]`.
 *
 * Reads only. Prints what the window would list, with the tier and the reason,
 * so the rules can be checked against a real disk without opening the app and
 * without any way to delete anything -- this file imports no eraser.
 */

import { resolve } from "node:path";
import { formatBytes, scan } from "./scan.js";

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error("Usage: npm run scan -- <folder> [<folder>…]");
  process.exit(2);
}

const result = await scan({
  targets: folders.map((folder, index) => ({ id: `t${index}`, path: resolve(folder), label: folder })),
});

const pad = (text, width) => String(text).padEnd(width).slice(0, width);
for (const item of result.items) {
  console.log(
    `${pad(item.tier, 8)} ${formatBytes(item.bytes).padStart(9)}  ${pad(item.stack?.label ?? item.kindLabel, 14)} ${item.displayPath}${item.type === "set" ? ` (${item.name})` : ""}`,
  );
  console.log(`${" ".repeat(20)}${item.reason}`);
}

const { stats } = result;
console.log("");
console.log(`${stats.dirs.toLocaleString()} folders, ${stats.projectsSeen} projects, ${(stats.elapsedMs / 1000).toFixed(1)}s${stats.stoppedBy ? ` (stopped: ${stats.stoppedBy})` : ""}`);
console.log(`safe ${formatBytes(stats.bytes.safe)} (${stats.counts.safe}) · review ${formatBytes(stats.bytes.review)} (${stats.counts.review}) · blocked ${formatBytes(stats.bytes.blocked)} (${stats.counts.blocked})`);
for (const rule of result.skipped) console.log(`declined ${rule.count}× ${rule.id} — e.g. ${rule.example}`);
