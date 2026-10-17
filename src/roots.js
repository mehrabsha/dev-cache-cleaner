/**
 * Where a scan may start, and how a path is shown.
 *
 * Two kinds of place: a drive somebody ticked, or a folder somebody picked in
 * a native dialog. Nothing else -- the scanner never decides on its own to
 * walk somewhere. Windows only.
 */

import { statfs } from "node:fs/promises";
import { homedir } from "node:os";

const HOME = homedir();
const SYSTEM_DRIVE = process.env.SystemDrive ?? "C:";

/** `C:\Users\someone\code\x` -> `~\code\x`. A username is not evidence. */
export function redact(absolutePath) {
  if (!absolutePath) return absolutePath;
  if (HOME && absolutePath.toLowerCase().startsWith(HOME.toLowerCase())) {
    return `~${absolutePath.slice(HOME.length)}`;
  }
  return absolutePath;
}

/**
 * What is mounted: each drive letter in turn, keeping the ones that answer.
 * There is no way to enumerate volumes from Node without a native module or a
 * shell, and this project has neither.
 */
export async function listDrives() {
  const candidates = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    path: `${letter}:\\`,
    label: `${letter}:`,
    system: `${letter}:`.toUpperCase() === SYSTEM_DRIVE.toUpperCase(),
  }));

  const drives = [];
  await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stats = await statfs(candidate.path);
        const total = stats.blocks * stats.bsize;
        if (!total) return;
        drives.push({
          id: `drive-${candidate.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          label: candidate.label,
          path: candidate.path,
          system: candidate.system,
          totalBytes: total,
          freeBytes: stats.bavail * stats.bsize,
        });
      } catch {
        /* not mounted, no media, or not ours to read */
      }
    }),
  );
  return drives.sort((a, b) => a.path.localeCompare(b.path));
}
