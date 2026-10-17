/**
 * Deciding what a delete request may touch. No removal happens here -- that
 * is `erase.js`, and only `electron/main.js` calls it.
 *
 * Three layers, each independent of the window:
 *
 *   select    ids, never paths: the window names `i7` and this looks it up in
 *             the scan the window was actually shown. Blocked rows and unknown
 *             ids are refused, whatever the UI did, and reported as refusals
 *   describe  the confirmation's wording -- what was ticked against its
 *             verdict, and which projects look like they are in use
 *   reverify  right before each `rm`, ask the disk again. A scan can be half
 *             an hour old; in that time a `dist` can have been committed, a
 *             folder swapped for a junction, or the marker deleted. The scan's
 *             verdict is a reason to ask, not permission to act
 */

import { basename, resolve, sep } from "node:path";
import { isPlainDirectory, markerFor } from "./scan.js";
import { toRepoPath, trackedCounts } from "./git.js";

export const MAX_BATCH = 500;
const ACTIVE_DAYS = 7;

export function selectRemovable(items, ids, { max = MAX_BATCH } = {}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const removable = [];
  const refused = [];
  for (const id of new Set(ids)) {
    const item = byId.get(id);
    if (!item) refused.push({ id, reason: "not in this scan" });
    else if (item.tier === "blocked") refused.push({ id, name: item.relPath, reason: item.reason });
    else if (removable.length >= max) refused.push({ id, name: item.relPath, reason: `more than ${max} in one batch` });
    else removable.push(item);
  }
  return { removable, refused };
}

export function describeRemoval(removable) {
  const bytes = removable.reduce((sum, item) => sum + item.bytes, 0);
  const warnings = [];

  const review = removable.filter((item) => item.tier === "review");
  const runtime = review.filter((item) => item.kind === "runtime");
  if (runtime.length) {
    warnings.push(`${runtime.length} ${runtime.length === 1 ? "is" : "are"} runtime data (uploads, logs…) — these do not come back.`);
  }
  if (review.length - runtime.length > 0) {
    warnings.push(`${review.length - runtime.length} ${review.length - runtime.length === 1 ? "was" : "were"} marked "Review", not "Safe".`);
  }

  const active = new Map();
  for (const item of removable) {
    const days = item.project?.lastActiveDays;
    if (days != null && days <= ACTIVE_DAYS) active.set(item.project.id, item.project.name);
  }
  if (active.size) {
    const names = [...active.values()].slice(0, 3).join(", ");
    warnings.push(`${active.size} project${active.size === 1 ? " was" : "s were"} worked on in the last ${ACTIVE_DAYS} days (${names}${active.size > 3 ? "…" : ""}) — a running dev server can keep files locked.`);
  }

  return { count: removable.length, bytes, warnings };
}

/** One line per item for the confirmation. */
export function describeScope(item) {
  if (item.type === "set") return `${item.name} under ${item.project?.displayDir ?? item.displayPath}`;
  return item.displayPath;
}

function within(child, parent) {
  const a = resolve(child).toLowerCase();
  const b = resolve(parent).toLowerCase().replace(/[\\/]+$/, "");
  return a.startsWith(b + sep);
}

/**
 * Ask the disk again. Returns null when the item may go, or the reason it
 * may not.
 */
export async function reverify(item, scanRoots) {
  const paths = item.type === "set" ? item.members ?? [] : [item.path];
  if (!paths.length) return "nothing recorded to delete";

  for (const path of paths) {
    if (!scanRoots.some((root) => within(path, root))) return "it is not inside a folder you scanned";
    if (basename(path).toLowerCase() !== String(item.artifactName).toLowerCase()) return "its name no longer matches";
    if (!(await isPlainDirectory(path))) return "it is gone, or it is now a link rather than a folder";
  }

  // The marker that made it safe has to still be there.
  if (item.type === "folder" && item.marker) {
    const marker = await markerFor(item.path, [item.marker]);
    if (!marker) return `${item.marker} is no longer inside it`;
  }

  // And still nothing committed. Only asked where git answered at scan time;
  // a repo git could not read then is not trusted now either.
  if (item.repoPath && item.git?.state === "ok") {
    const rels = paths.map((path) => toRepoPath(item.repoPath, path)).filter(Boolean);
    const counts = await trackedCounts(item.repoPath, rels);
    if (!counts) return "git could not confirm that nothing inside is committed";
    const tracked = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (tracked > 0) return `${tracked} file${tracked === 1 ? " is" : "s are"} committed inside it now`;
  }

  return null;
}
