/**
 * The one file in this project that starts another program.
 *
 * Two questions decide most verdicts, and git is the only thing that can
 * answer them honestly:
 *
 *   ignored   does this repository's .gitignore say the folder is not source?
 *   tracked   are any files inside it committed? A `dist` with committed files
 *             in it is source that happens to be called dist -- GDevelop ships
 *             vendored libraries that way -- and deleting it loses work.
 *
 * Rules this module keeps, and the self-check asserts:
 *
 *   - `execFile`, never `exec` or `spawn` with a shell: arguments are an
 *     array, so a folder name can never become a command
 *   - git is always run with `-C <repo root>` and one of three fixed
 *     subcommands: `check-ignore`, `ls-files`, `--version`
 *   - paths go in over stdin or after `--`, so a name starting with `-` is a
 *     path and not a flag
 *   - no git, or a git that refuses, degrades to "unknown" -- never to "safe"
 */

import { execFile } from "node:child_process";

const GIT_OPTIONS = { windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 };

/**
 * Settings every call carries. `safe.directory=*` because repositories on a
 * second drive routinely belong to a different Windows SID than the person
 * running this, and git then refuses to answer anything at all; quotepath off
 * so non-ASCII names come back as themselves.
 */
const BASE_ARGS = ["-c", "safe.directory=*", "-c", "core.quotepath=off"];

function run(args, { input, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", [...BASE_ARGS, ...args], { ...GIT_OPTIONS, cwd }, (error, stdout, stderr) => {
      // check-ignore exits 1 when nothing matched, which is an answer, not a failure.
      const code = error?.code ?? 0;
      resolve({ ok: !error || code === 1, code, stdout: stdout ?? "", stderr: stderr ?? "", error });
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

let availability = null;

/** Is there a git on PATH at all? Asked once per launch. */
export async function gitAvailable() {
  availability ??= run(["--version"]).then((result) => result.ok && /git version/.test(result.stdout));
  return availability;
}

/** Forward slashes, relative to the repo root -- the only shape git reads. */
export function toRepoPath(repoRoot, absolutePath) {
  const root = repoRoot.replace(/[\\/]+$/, "");
  if (!absolutePath.toLowerCase().startsWith(root.toLowerCase())) return null;
  const rel = absolutePath.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return rel || null;
}

/**
 * Which of these paths does git ignore, and which rule says so?
 *
 * One process per repository, paths over stdin. `-v -n` makes git answer for
 * every path, matched or not, so a path that is *not* ignored is reported as
 * such rather than merely missing from the output. A tracked path is never
 * reported as ignored, which is the behaviour wanted here.
 *
 * Returns `Map<relPath, { ignored, source, line, pattern }>`, or null when git
 * could not answer.
 */
export async function checkIgnored(repoRoot, relPaths) {
  if (!relPaths.length) return new Map();
  if (!(await gitAvailable())) return null;

  // Directories are asked with a trailing slash so `dist/`-style rules match.
  const input = relPaths.map((path) => `${path}/`).join("\0") + "\0";
  const result = await run(["-C", repoRoot, "check-ignore", "-v", "-n", "-z", "--stdin"], { input });
  if (!result.ok) return null;

  const fields = result.stdout.split("\0");
  const answers = new Map();
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, line, pattern, path] = fields.slice(index, index + 4);
    const rel = path.replace(/\/+$/, "");
    // A negated pattern (`!keep/`) matches without ignoring.
    const ignored = Boolean(source) && !pattern.startsWith("!");
    answers.set(rel, { ignored, source: source || null, line: line ? Number(line) : null, pattern: pattern || null });
  }
  return answers;
}

/**
 * How many committed files sit under each of these directories?
 *
 * `ls-files` lists the index, so this is "committed or staged" -- exactly the
 * set of files deleting the folder would lose from the working tree. Chunked,
 * because a Windows command line tops out near 32K characters.
 *
 * Returns `Map<relPath, count>`, or null when git could not answer.
 */
export async function trackedCounts(repoRoot, relPaths) {
  const counts = new Map(relPaths.map((path) => [path, 0]));
  if (!relPaths.length) return counts;
  if (!(await gitAvailable())) return null;

  const chunks = [];
  let current = [];
  let length = 0;
  for (const path of relPaths) {
    if (length + path.length > 20_000 && current.length) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(path);
    length += path.length + 3;
  }
  if (current.length) chunks.push(current);

  // Longest first, so `a/b` claims its files before `a` would.
  const ordered = [...relPaths].sort((a, b) => b.length - a.length);
  for (const chunk of chunks) {
    const result = await run(["-C", repoRoot, "ls-files", "-z", "--", ...chunk]);
    if (!result.ok) return null;
    for (const file of result.stdout.split("\0")) {
      if (!file) continue;
      const lower = file.toLowerCase();
      const owner = ordered.find((path) => lower.startsWith(`${path.toLowerCase()}/`) || lower === path.toLowerCase());
      if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  return counts;
}
