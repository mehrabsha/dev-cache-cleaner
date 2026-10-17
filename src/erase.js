/**
 * The only file in this project that removes anything.
 *
 * Carried over from disk-janitor, because its rules are the right ones: it
 * imports exactly `{ readdir, rm }`, calls `rm` at exactly three sites with
 * exactly the options below, and the self-check asserts all of it. Every other
 * shipped file is grepped for `unlink`, `rm`, `writeFile`, `rename` and fails
 * the build on a hit.
 *
 * Removal here is **permanent**. No Recycle Bin, no undo.
 *
 *   guard     no drive root, no home folder, nothing shallow enough to be
 *             one, whatever the caller asked for
 *   set       a scattered artifact (`__pycache__` ×40) removes its named
 *             member paths one at a time and never the project folder its
 *             `path` points at; each member must be named exactly like the
 *             artifact, and an incomplete member list is refused outright
 */

import { readdir, rm } from "node:fs/promises";
import { basename, join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";

/**
 * Options the one removal call is made with, kept here to be asserted.
 * Retries cover the brief EBUSY/EPERM a virus scanner or indexer causes on
 * Windows; a dev server holding files open will still fail, and says so.
 */
export const ERASE_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 250 };

/** Structural refusals, independent of any rule about what the folder is. */
export function guardPath(absolutePath) {
  if (!absolutePath || typeof absolutePath !== "string") return "no path";

  const full = resolve(absolutePath);
  const { root } = parse(full);
  const home = resolve(homedir());

  if (full === root) return "a drive root";
  if (full.toLowerCase() === home.toLowerCase()) return "the home folder itself";
  if (home.toLowerCase().startsWith(full.toLowerCase() + sep)) return "a parent of the home folder";

  const below = full.slice(root.length).split(sep).filter(Boolean);
  if (below.length < 2) return "too close to the top of the drive";

  return null;
}

/** Turn an `rm` failure into something a person can act on. */
export function describeEraseError(error) {
  const code = error?.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY") {
    return `Locked (${code}) — something still has files open in it. Close the dev server, IDE or emulator and try again.`;
  }
  return error?.message ?? String(error);
}

/** Pieces removed at once. Deleting is mostly waiting on the disk, one file at a time. */
export const ERASE_WIDTH = 16;

const stopped = () => Object.assign(new Error("Stopped — partly deleted. Scan again to see what is left."), { stopped: true });

/**
 * The pieces a folder is removed in: its children, and the children of its
 * child folders. One `rm` of a whole `node_modules` is a single call that says
 * nothing for a minute; a few thousand smaller ones can run side by side and
 * report as they go. Links are pieces of their own and never entered -- `rm`
 * removes a link, not what it points at, which is what keeps pnpm's store safe.
 */
async function piecesOf(path) {
  const pieces = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      pieces.push(child);
      continue;
    }
    let inner;
    try {
      inner = await readdir(child, { withFileTypes: true });
    } catch {
      inner = null;
    }
    if (inner?.length) for (const grand of inner) pieces.push(join(child, grand.name));
    else pieces.push(child);
  }
  return pieces;
}

/**
 * Remove one item, permanently. Returns what was actually removed, so the
 * caller reports the truth rather than the intent.
 *
 * `onProgress(done, total)` is called as pieces go; `signal` stops between
 * pieces. A stopped folder is left partly deleted and says so.
 */
export async function eraseItem(item, { onProgress, signal } = {}) {
  if (item.type === "set") {
    const members = item.members ?? [];
    if (!members.length) throw new Error("Refused: this row's members were never recorded");
    if (item.membersComplete === false) throw new Error("Refused: too many folders to name them all");

    let removed = 0;
    for (const member of members) {
      if (signal?.aborted) throw stopped();
      const guard = guardPath(member);
      if (guard) throw new Error(`Refused: ${guard}`);
      // Every member is named like the artifact, or it is not a member.
      if (basename(member).toLowerCase() !== String(item.artifactName).toLowerCase()) {
        throw new Error(`Refused: "${member}" is not a ${item.artifactName} folder`);
      }
      await rm(member, ERASE_OPTIONS);
      removed += 1;
      onProgress?.(removed, members.length);
    }
    return { removed, of: members.length, kind: "members" };
  }

  const guard = guardPath(item?.path);
  if (guard) throw new Error(`Refused: ${guard}`);

  const pieces = await piecesOf(item.path);
  let done = 0;
  let cursor = 0;
  onProgress?.(0, pieces.length);
  const worker = async () => {
    while (cursor < pieces.length && !signal?.aborted) {
      const piece = pieces[cursor++];
      await rm(piece, ERASE_OPTIONS);
      done += 1;
      onProgress?.(done, pieces.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ERASE_WIDTH, Math.max(1, pieces.length)) }, worker));
  if (signal?.aborted) throw stopped();

  // What is left is the empty skeleton of the folder itself.
  await rm(item.path, ERASE_OPTIONS);
  return { removed: 1, of: 1, kind: "folder" };
}
