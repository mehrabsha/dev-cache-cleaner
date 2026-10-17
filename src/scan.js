/**
 * The walk. No network and no writes -- `node:fs/promises` is imported for
 * `readdir` and `lstat` and nothing else.
 *
 * It does three things in order:
 *
 *   walk      descend from each picked place. At every directory, ask which
 *             stacks it is the root of (stacks.js). A child directory that one
 *             of those stacks owns becomes a candidate and is *not* entered --
 *             so the nested node_modules inside node_modules is counted once,
 *             as part of its parent, and never offered on its own.
 *   measure   size every candidate in full, a few at a time.
 *   ask git   one `check-ignore` and one `ls-files` per repository, batched.
 *
 * Then verdict.js turns each candidate's evidence into safe / review /
 * blocked. Symbolic links and junctions are never followed: pnpm's store is
 * all junctions, and a cleaner that counts the same bytes twice lies.
 */

import { readdir, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { redact } from "./roots.js";
import { skipFor } from "./skips.js";
import { readManifest } from "./manifest.js";
import {
  claimFor,
  describeProject,
  detectStacks,
  KINDS,
  ORPHAN_MARKERS,
  RUNTIME_NAMES,
  scatteredClaimFor,
  STACKS,
  SUSPECT_NAMES,
} from "./stacks.js";
import { checkIgnored, gitAvailable, toRepoPath, trackedCounts } from "./git.js";
import { judge } from "./verdict.js";

export const SCAN_LIMITS = {
  /** A backstop for a runaway sweep, not a schedule. The Stop button is the real bound. */
  budgetMs: 30 * 60_000,
  maxEntries: 30_000_000,
  statWidth: 32,
  dirWidth: 8,
  /** Candidates measured at once. Each is itself parallel inside. */
  measureWidth: 4,
  /** Below this a regenerable folder is not worth a row. */
  minItemBytes: 1024 * 1024,
  /** Runtime data has to be big to be worth a look. */
  runtimeMinBytes: 100 * 1024 * 1024,
  /** Unclaimed folders are listed only when they are big enough to wonder about. */
  unclaimedMinBytes: 20 * 1024 * 1024,
  /** Members of a scattered artifact (`__pycache__`) recorded by path. */
  maxMembers: 20_000,
};

const DAY_MS = 86_400_000;
const ALL_MANIFESTS = new Set(
  STACKS.flatMap((stack) => stack.manifests ?? []).map((name) => name.toLowerCase()),
);
const MANIFEST_PATTERNS = STACKS.flatMap((stack) => stack.manifestPatterns ?? []);

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export const ageInDays = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.floor((Date.now() - ms) / DAY_MS) : null);

/**
 * Run `fn` over `items`, at most `limit` at a time. The recursion below never
 * holds a slot while waiting on its children, which is how a pool deadlocks.
 */
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function statOr(path, ctx) {
  ctx?.tick?.();
  try {
    return await lstat(path);
  } catch (error) {
    ctx?.note(path, error);
    return null;
  }
}

async function listOr(path, ctx) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    ctx?.note(path, error);
    return null;
  }
}

/**
 * Toolchains with ordinary names, recognised by their contents.
 *
 * emsdk's bundled Node lives at `emsdk\node\20.18.0_64bit\bin`, and that
 * `bin` has a `node_modules` holding npm itself. Nothing about the *name*
 * says "do not touch"; `node.exe` sitting beside it does.
 */
export function toolchainFor(names) {
  const has = (name) => names.some((entry) => entry.toLowerCase() === name);
  if (has("emsdk.py") || has("emsdk_manifest.json")) return "the Emscripten SDK";
  if (has("node.exe") && (has("npm.cmd") || has("node_modules")) && !has("package.json")) return "a Node.js installation";
  if (has("platform-tools") || has("build-tools") || (has("platforms") && has("system-images"))) return "the Android SDK";
  if ((has("python.exe") && has("lib")) || has("pyvenv.cfg")) return "a Python installation";
  if (has("flutter_console.bat") || (has("bin") && has("packages") && has("version") && has("dev") && has("analysis_options.yaml"))) {
    return "the Flutter SDK";
  }
  if (has("rustc.exe") || has("cargo.exe")) return "a Rust toolchain";
  return null;
}

/**
 * What a person calls this project: its folder. When the folder has a generic
 * name -- `frontend`, `app`, `android` -- its parent goes in front, so the
 * sidebar reads "shop/frontend" rather than three rows called "app".
 */
const GENERIC_DIRS = new Set([
  "app", "apps", "web", "frontend", "backend", "api", "server", "client", "mobile", "android", "ios",
  "admin", "site", "docs", "ui", "core", "src", "packages", "desktop", "landing", "dashboard", "www",
]);

export function projectName(dir) {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return dir;
  // Climb past generic names to the first one that says something:
  // `shop\mobile\android\app` -> "shop/mobile/android/app".
  let start = parts.length - 1;
  while (start > 0 && GENERIC_DIRS.has(parts[start].toLowerCase()) && parts.length - start < 4) start -= 1;
  return parts.slice(Math.max(start, 1)).join("/");
}

/** The first marker present inside `path`, by exact name, or null. */
export async function markerFor(path, markers, ctx) {
  if (!markers?.length) return null;
  const entries = await listOr(path, ctx);
  if (!entries) return null;
  const present = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.name]));
  for (const marker of markers) {
    const found = present.get(marker.toLowerCase());
    if (found) return found;
  }
  return null;
}

/** Is `path` still a real directory (not a link)? Used again right before deleting. */
export async function isPlainDirectory(path) {
  const stats = await statOr(path, null);
  return Boolean(stats?.isDirectory()) && !stats.isSymbolicLink();
}

function emptyTotals() {
  return { bytes: 0, files: 0, dirs: 0, newest: 0, truncated: false };
}

/** Measure one subtree whole. No skips inside: a candidate is counted in full. */
async function measure(dir, ctx) {
  const totals = emptyTotals();
  if (ctx.stop()) {
    totals.truncated = true;
    return totals;
  }
  const entries = await listOr(dir, ctx);
  if (!entries) {
    totals.truncated = true;
    return totals;
  }

  const files = [];
  const dirs = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    ctx.entries += 1;
    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile()) files.push(entry.name);
  }

  await mapLimit(files, ctx.limits.statWidth, async (name) => {
    if (ctx.stop()) {
      totals.truncated = true;
      return;
    }
    const stats = await statOr(join(dir, name), ctx);
    if (!stats) return;
    totals.bytes += stats.size;
    totals.files += 1;
    ctx.measuredBytes += stats.size;
    if (stats.mtimeMs > totals.newest) totals.newest = stats.mtimeMs;
  });

  await mapLimit(dirs, ctx.limits.dirWidth, async (name) => {
    if (ctx.stop()) {
      totals.truncated = true;
      return;
    }
    const child = await measure(join(dir, name), ctx);
    totals.bytes += child.bytes;
    totals.files += child.files;
    totals.dirs += child.dirs + 1;
    totals.newest = Math.max(totals.newest, child.newest);
    totals.truncated ||= child.truncated;
  });

  return totals;
}

/**
 * When was this project last worked on?
 *
 * The newest mtime among its own top-level files, plus `.git/index` when the
 * project is a repository root -- that file moves on every checkout, commit
 * and `git add`. Shallow on purpose: it is a hint for the confirmation
 * ("a dev server may be holding files open"), not a measurement.
 */
async function lastActive(dir, names, ctx) {
  let newest = 0;
  const probes = names.filter((name) => !SUSPECT_NAMES.has(name.toLowerCase())).slice(0, 60);
  await mapLimit(probes, ctx.limits.statWidth, async (name) => {
    const stats = await statOr(join(dir, name), null);
    if (stats?.isFile() && stats.mtimeMs > newest) newest = stats.mtimeMs;
  });
  if (names.includes(".git")) {
    const index = await statOr(join(dir, ".git", "index"), null);
    if (index && index.mtimeMs > newest) newest = index.mtimeMs;
  }
  return newest || null;
}

/**
 * Scan the given places.
 *
 * `targets` are `{ id, path, label }`, already resolved by main against what is
 * mounted or what the native folder dialog returned -- never a path the
 * window typed.
 */
export async function scan({ targets = [], includeRuntime = true, limits = {}, signal, onProgress } = {}) {
  const settings = { ...SCAN_LIMITS, ...limits };
  const startedAt = Date.now();
  const deadline = startedAt + settings.budgetMs;
  const unreadable = [];
  const skipped = new Map();
  const candidates = [];
  const scatteredByProject = new Map();
  const projects = new Map();

  const ctx = {
    entries: 0,
    dirs: 0,
    measured: 0,
    measuredBytes: 0,
    phase: "walk",
    current: "",
    limits: settings,
    recent: [],
    stopReason() {
      if (signal?.aborted) return "cancelled";
      if (Date.now() > deadline) return "time";
      if (this.entries > settings.maxEntries) return "entries";
      return null;
    },
    stop() {
      return this.stopReason() !== null;
    },
    note(path, error) {
      if (unreadable.length < 200) unreadable.push({ path: redact(path), code: error?.code ?? "ERROR" });
    },
    skip(path, scanRoot) {
      const rule = skipFor(path, { scanRoot });
      if (!rule) return false;
      this.declined(rule.id, rule.why, path);
      return true;
    },
    declined(id, why, path) {
      const tally = skipped.get(id) ?? { id, why, count: 0, example: null };
      tally.count += 1;
      tally.example ??= redact(path);
      skipped.set(id, tally);
    },
    lastTick: 0,
    tick(force = false) {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - this.lastTick < 150) return;
      this.lastTick = now;
      const recent = this.recent;
      this.recent = [];
      onProgress({
        phase: this.phase,
        entries: this.entries,
        dirs: this.dirs,
        projects: projects.size,
        candidates: candidates.length,
        measured: this.measured,
        measuredBytes: this.measuredBytes,
        elapsedMs: now - startedAt,
        current: this.current,
        recent,
      });
    },
  };

  // ── walk ─────────────────────────────────────────────────────────────────

  const walk = async (dir, chain) => {
    if (ctx.stop()) return;
    const entries = await listOr(dir, ctx);
    if (!entries) return;
    ctx.dirs += 1;
    ctx.entries += entries.length;
    ctx.current = redact(dir);
    ctx.tick();

    const visible = entries.filter((entry) => !entry.isSymbolicLink());
    const names = visible.map((entry) => entry.name);

    const toolchain = toolchainFor(names);
    if (toolchain) {
      ctx.declined("toolchain-contents", "An SDK or runtime install, recognised by what is inside it — its node_modules and builds are part of the tool.", dir);
      return;
    }

    const repo = names.includes(".git") ? dir : chain.repo;

    let project = null;
    const lower = names.map((name) => name.toLowerCase());
    if (lower.some((name) => ALL_MANIFESTS.has(name)) || names.some((name) => MANIFEST_PATTERNS.some((p) => p.test(name)))) {
      const facts = await describeProject(dir, names, (name) => readManifest(dir, name));
      const stacks = detectStacks(facts);
      if (stacks.length) {
        project = {
          ...facts,
          id: `p${projects.size + 1}`,
          stacks,
          name: projectName(dir),
          packageName: typeof facts.pkg?.name === "string" ? facts.pkg.name : null,
          displayDir: redact(dir),
          manifest: names.find((name) => stacks[0].manifests?.some((m) => m.toLowerCase() === name.toLowerCase())) ?? names.find((name) => MANIFEST_PATTERNS.some((p) => p.test(name))),
          lastActiveMs: await lastActive(dir, names, ctx),
          repo,
        };
        projects.set(dir, project);
      }
    }

    const lineage = project ? [...chain.projects, project] : chain.projects;
    const subdirs = [];

    for (const entry of visible) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const name = entry.name;
      const lowerName = name.toLowerCase();

      if (ctx.skip(full, chain.scanRoot)) continue;

      const claim = project ? claimFor(project, project.stacks, name) : null;
      if (claim) {
        candidates.push({ path: full, name, project, claim, repo, manifest: project.manifest });
        ctx.recent.push({ name, project: project.name, stack: claim.stack.label });
        continue;
      }

      const scatteredOwner = [...lineage].reverse().find((candidate) => scatteredClaimFor(candidate.stacks, name));
      if (scatteredOwner) {
        const group = scatteredByProject.get(scatteredOwner.dir) ?? {
          project: scatteredOwner,
          claim: scatteredClaimFor(scatteredOwner.stacks, name),
          members: [],
          repo: scatteredOwner.repo,
        };
        group.members.push({ path: full, repo });
        scatteredByProject.set(scatteredOwner.dir, group);
        continue;
      }

      if (project && includeRuntime && RUNTIME_NAMES.has(lowerName)) {
        candidates.push({ path: full, name, project, runtime: true, repo, manifest: project.manifest });
        continue;
      }

      if (SUSPECT_NAMES.has(lowerName)) {
        candidates.push({ path: full, name, project: lineage.at(-1) ?? null, unclaimed: true, repo });
        continue;
      }

      subdirs.push(full);
    }

    await mapLimit(subdirs, settings.dirWidth, (child) => walk(child, { projects: lineage, repo, scanRoot: chain.scanRoot }));
  };

  ctx.tick(true);
  for (const target of targets) {
    if (ctx.stop()) break;
    if (!(await isPlainDirectory(target.path))) {
      unreadable.push({ path: redact(target.path), code: "NOT_A_FOLDER" });
      continue;
    }
    // A repository *above* the picked folder still governs what is ignored in it.
    await walk(target.path, { projects: [], repo: await repoAbove(target.path), scanRoot: target.path });
  }

  // Scattered artifacts become one candidate per project.
  for (const group of scatteredByProject.values()) {
    candidates.push({
      path: group.project.dir,
      name: group.claim.artifact.name,
      project: group.project,
      claim: group.claim,
      repo: group.repo,
      manifest: group.project.manifest,
      scattered: true,
      members: group.members.slice(0, settings.maxMembers),
      membersComplete: group.members.length <= settings.maxMembers,
    });
  }

  // ── measure ──────────────────────────────────────────────────────────────

  ctx.phase = "measure";
  ctx.tick(true);
  await mapLimit(candidates, settings.measureWidth, async (candidate) => {
    if (candidate.scattered) {
      const totals = emptyTotals();
      for (const member of candidate.members) {
        const part = await measure(member.path, ctx);
        totals.bytes += part.bytes;
        totals.files += part.files;
        totals.dirs += part.dirs + 1;
        totals.newest = Math.max(totals.newest, part.newest);
        totals.truncated ||= part.truncated;
        member.bytes = part.bytes;
      }
      candidate.totals = totals;
    } else {
      ctx.current = redact(candidate.path);
      candidate.totals = await measure(candidate.path, ctx);
      candidate.marker = await markerFor(
        candidate.path,
        candidate.unclaimed ? ORPHAN_MARKERS.get(candidate.name.toLowerCase()) : candidate.claim?.artifact.markers,
        ctx,
      );
    }
    ctx.measured += 1;
    ctx.tick();
  });

  // Drop what is too small to matter before asking git about it.
  const worthIt = candidates.filter((candidate) => {
    const bytes = candidate.totals?.bytes ?? 0;
    if (candidate.runtime) return bytes >= settings.runtimeMinBytes;
    if (candidate.unclaimed) return bytes >= settings.unclaimedMinBytes;
    return bytes >= settings.minItemBytes;
  });

  // ── git ──────────────────────────────────────────────────────────────────

  ctx.phase = "git";
  ctx.tick(true);
  const hasGit = await gitAvailable();
  const byRepo = new Map();
  for (const candidate of worthIt) {
    if (!candidate.repo) continue;
    const paths = candidate.scattered ? candidate.members.map((member) => member.path) : [candidate.path];
    const list = byRepo.get(candidate.repo) ?? [];
    for (const path of paths) {
      const rel = toRepoPath(candidate.repo, path);
      if (rel) list.push(rel);
    }
    byRepo.set(candidate.repo, list);
  }

  const answers = new Map();
  for (const [repo, rels] of byRepo) {
    if (ctx.stopReason() === "cancelled") break;
    ctx.current = redact(repo);
    ctx.tick();
    const [ignore, tracked] = hasGit ? await Promise.all([checkIgnored(repo, rels), trackedCounts(repo, rels)]) : [null, null];
    answers.set(repo, { ignore, tracked });
  }

  const gitFor = (repo, path) => {
    if (!repo) return { state: "none" };
    if (!hasGit) return { state: "unavailable" };
    const answer = answers.get(repo);
    if (!answer?.ignore || !answer?.tracked) return { state: "error" };
    const rel = toRepoPath(repo, path);
    return { state: "ok", ignore: answer.ignore.get(rel) ?? null, tracked: answer.tracked.get(rel) ?? null };
  };

  // ── judge ────────────────────────────────────────────────────────────────

  const items = [];
  let nextId = 1;
  for (const candidate of worthIt) {
    let git;
    if (candidate.scattered) {
      // A member with committed files is dropped from the set rather than
      // blocking the rest; the set is ignored only if every member is.
      const states = candidate.members.map((member) => ({ member, git: gitFor(candidate.repo, member.path) }));
      const kept = states.filter(({ git: state }) => !(state.state === "ok" && state.tracked > 0));
      candidate.members = kept.map(({ member }) => member);
      candidate.totals.bytes = candidate.members.reduce((sum, member) => sum + (member.bytes ?? 0), 0);
      const first = states[0]?.git ?? { state: "none" };
      git = first.state === "ok"
        ? {
            state: "ok",
            tracked: 0,
            ignore: kept.every(({ git: state }) => state.ignore?.ignored) ? kept[0]?.git.ignore ?? null : { ignored: false },
          }
        : first;
      if (!candidate.members.length || candidate.totals.bytes < settings.minItemBytes) continue;
    } else {
      git = gitFor(candidate.repo, candidate.path);
    }

    const verdict = judge({
      name: candidate.name,
      claim: candidate.claim ?? null,
      runtime: Boolean(candidate.runtime),
      scattered: Boolean(candidate.scattered),
      marker: candidate.marker ?? null,
      manifest: candidate.manifest,
      projectName: candidate.project?.name,
      git,
    });

    // Runtime data git does not ignore is somebody's data, not a finding.
    if (candidate.runtime && git.state === "ok" && !git.ignore?.ignored) continue;

    const kind = candidate.runtime ? KINDS.runtime : candidate.unclaimed ? KINDS.unknown : KINDS[candidate.claim.artifact.kind];
    const project = candidate.project;
    // Outside any project a bare "out" says nothing, so the parent goes in front.
    const relPath = project
      ? candidate.path.slice(project.dir.length).replace(/^[\\/]+/, "")
      : candidate.path.split(/[\\/]+/).filter(Boolean).slice(-2).join("\\");

    items.push({
      id: `i${nextId++}`,
      type: candidate.scattered ? "set" : "folder",
      path: candidate.path,
      displayPath: redact(candidate.path),
      name: candidate.scattered ? `${candidate.members.length} × ${candidate.name}` : candidate.name,
      artifactName: candidate.name,
      relPath: candidate.scattered ? `${candidate.members.length} × ${candidate.name}` : relPath || candidate.name,
      kind: kind.id,
      kindLabel: kind.label,
      stack: candidate.claim ? { id: candidate.claim.stack.id, label: candidate.claim.stack.label } : null,
      project: project
        ? {
            id: project.id,
            name: project.name,
            packageName: project.packageName,
            dir: project.dir,
            displayDir: project.displayDir,
            stacks: project.stacks.map((stack) => stack.label),
            lastActiveMs: project.lastActiveMs,
            lastActiveDays: ageInDays(project.lastActiveMs),
          }
        : null,
      bytes: candidate.totals.bytes,
      files: candidate.totals.files,
      dirs: candidate.totals.dirs,
      newestMs: candidate.totals.newest || null,
      ageDays: ageInDays(candidate.totals.newest),
      truncated: candidate.totals.truncated,
      marker: candidate.marker ?? null,
      markers: candidate.claim?.artifact.markers ?? ORPHAN_MARKERS.get(candidate.name.toLowerCase()) ?? [],
      regen: candidate.claim?.artifact.regen ? candidate.claim.artifact.regen(project) : null,
      repo: candidate.repo ? redact(candidate.repo) : null,
      repoPath: candidate.repo ?? null,
      git: { state: git.state, tracked: git.tracked ?? null, ignored: git.ignore?.ignored ?? null },
      members: candidate.scattered ? candidate.members.map((member) => member.path) : null,
      membersComplete: candidate.scattered ? candidate.membersComplete : null,
      tier: verdict.tier,
      reason: verdict.reason,
      evidence: verdict.evidence,
    });
  }

  items.sort((a, b) => b.bytes - a.bytes);

  const projectList = [...projects.values()]
    .map((project) => {
      const own = items.filter((item) => item.project?.id === project.id);
      return {
        id: project.id,
        name: project.name,
        displayDir: project.displayDir,
        stacks: project.stacks.map((stack) => stack.label),
        lastActiveDays: ageInDays(project.lastActiveMs),
        items: own.length,
        bytes: own.reduce((sum, item) => sum + item.bytes, 0),
        safeBytes: own.filter((item) => item.tier === "safe").reduce((sum, item) => sum + item.bytes, 0),
      };
    })
    .filter((project) => project.items > 0)
    .sort((a, b) => b.bytes - a.bytes);

  const sumTier = (tier) => items.filter((item) => item.tier === tier).reduce((sum, item) => sum + item.bytes, 0);
  const stoppedBy = ctx.stopReason();
  ctx.phase = "done";
  ctx.tick(true);

  return {
    items,
    projects: projectList,
    unreadable,
    skipped: [...skipped.values()].sort((a, b) => b.count - a.count),
    stats: {
      elapsedMs: Date.now() - startedAt,
      entries: ctx.entries,
      dirs: ctx.dirs,
      projectsSeen: projects.size,
      candidates: candidates.length,
      git: hasGit,
      stoppedBy,
      bytes: { safe: sumTier("safe"), review: sumTier("review"), blocked: sumTier("blocked") },
      counts: {
        safe: items.filter((item) => item.tier === "safe").length,
        review: items.filter((item) => item.tier === "review").length,
        blocked: items.filter((item) => item.tier === "blocked").length,
      },
      limits: settings,
    },
  };
}

/**
 * The repository a picked folder sits inside, if any. Walks up looking for a
 * `.git` entry -- a picked `apps\web` inside a monorepo is still governed by
 * the monorepo's .gitignore.
 */
async function repoAbove(path) {
  let current = path;
  for (let depth = 0; depth < 40; depth += 1) {
    if (await statOr(join(current, ".git"), null)) return current;
    const parent = join(current, "..");
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
