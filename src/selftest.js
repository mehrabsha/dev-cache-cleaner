/**
 * The self-check: `npm run check`. Offline, no Electron, about a second.
 *
 * Two halves, in the shape disk-janitor's self-check has:
 *
 *   audits    read the shipped source and assert the rails are where the
 *             README says they are -- exactly one file removes, exactly one
 *             file starts a process, every filesystem import is enumerated,
 *             the window is isolated and cannot reach the eraser
 *   fixtures  build real project trees in the temp folder -- every trap met
 *             while cleaning real disks by hand: a committed `dist`, the Node
 *             inside emsdk, a `build` nobody owns, nested `.cxx` builds, an
 *             editor extension's node_modules -- scan them, and assert each
 *             one lands in the tier it must. Then delete for real, inside the
 *             temp folder only, and check the bystanders are still there.
 *
 * This file is exempt from the write ban because it has to build fixtures; it
 * only ever writes under a fresh `mkdtemp` directory and removes it at the end.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { scan, toolchainFor } from "./scan.js";
import { judge } from "./verdict.js";
import { eraseItem, ERASE_OPTIONS, guardPath } from "./erase.js";
import { describeRemoval, MAX_BATCH, reverify, selectRemovable } from "./removal.js";
import { skipFor } from "./skips.js";
import { gitAvailable } from "./git.js";
import { claimFor, describeProject, detectStacks } from "./stacks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let passes = 0;

function test(name, fn) {
  try {
    fn();
    passes += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
}

// ── audits ──────────────────────────────────────────────────────────────────

const SHIPPED_DIRS = ["src", "electron", "app"];
const shipped = SHIPPED_DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => /\.(c?js)$/.test(name) && name !== "selftest.js")
    .map((name) => ({ rel: `${dir}/${name}`, text: readFileSync(join(ROOT, dir, name), "utf8") })),
);

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (rel) => stripComments(shipped.find((file) => file.rel === rel)?.text ?? "");

const BANNED_WRITES =
  /\b(unlink|unlinkSync|rmdir|rmdirSync|rmSync|writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|mkdir|mkdirSync|copyFile|copyFileSync|chmod|chown|utimes|truncate|symlink|createWriteStream)\b|\brm\s*\(|\bcp\s*\(/;
const BANNED_PROCESS = /child_process|\bexecSync\b|\bspawn\s*\(|\bspawnSync\b|\bexec\s*\(|\bfork\s*\(/;

test("audit: at least 12 shipped files were read", () => {
  assert.ok(shipped.length >= 12, `only ${shipped.length}`);
});

test("audit: nothing but src/erase.js removes or writes", () => {
  const hits = shipped
    .filter((file) => file.rel !== "src/erase.js")
    .filter((file) => BANNED_WRITES.test(stripComments(file.text)))
    .map((file) => `${file.rel}: ${stripComments(file.text).match(BANNED_WRITES)[0]}`);
  assert.deepEqual(hits, []);
});

test("audit: erase.js imports exactly { readdir, rm } and calls rm three times, all with ERASE_OPTIONS", () => {
  const text = code("src/erase.js");
  assert.ok(text.includes('import { readdir, rm } from "node:fs/promises";'));
  const fsImports = text.match(/from "node:fs[^"]*"/g) ?? [];
  assert.equal(fsImports.length, 1);
  const calls = text.match(/\brm\s*\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 3, calls.join(" | "));
  for (const call of calls) assert.ok(call.endsWith("ERASE_OPTIONS)"), call);
  assert.deepEqual(ERASE_OPTIONS, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
});

test("audit: only electron/main.js imports the eraser", () => {
  const importers = shipped.filter((file) => /from\s+["'][^"']*erase\.js["']/.test(file.text)).map((file) => file.rel);
  assert.deepEqual(importers, ["electron/main.js"]);
});

test("audit: only src/git.js starts a process, with execFile and no shell", () => {
  const hits = shipped
    .filter((file) => file.rel !== "src/git.js")
    .filter((file) => BANNED_PROCESS.test(stripComments(file.text)))
    .map((file) => file.rel);
  assert.deepEqual(hits, []);
  const git = code("src/git.js");
  assert.ok(git.includes('import { execFile } from "node:child_process";'));
  assert.equal((git.match(/child_process/g) ?? []).length, 1);
  assert.ok(!/shell\s*:/.test(git), "git.js passes a shell option");
  assert.ok(!/\bexec\s*\(|spawn|fork\s*\(/.test(git), "git.js uses something other than execFile");
  assert.equal((git.match(/execFile\(/g) ?? []).length, 1);
});

test("audit: every filesystem import is enumerated and read-only", () => {
  const expected = {
    "src/erase.js": 'import { readdir, rm } from "node:fs/promises";',
    "src/manifest.js": 'import { readFile } from "node:fs/promises";',
    "src/roots.js": 'import { statfs } from "node:fs/promises";',
    "src/scan.js": 'import { readdir, lstat } from "node:fs/promises";',
  };
  const importers = shipped.filter((file) => /from\s+["'](node:)?fs(\/promises)?["']|require\(["'](node:)?fs/.test(file.text)).map((file) => file.rel);
  assert.deepEqual(importers.sort(), Object.keys(expected).sort());
  for (const [rel, line] of Object.entries(expected)) assert.ok(code(rel).includes(line), `${rel} does not import exactly: ${line}`);
});

test("audit: the window is isolated and cannot reach the disk", () => {
  const main = code("electron/main.js");
  for (const flag of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"]) assert.ok(main.includes(flag), flag);
  for (const file of shipped.filter((entry) => entry.rel.startsWith("app/"))) {
    const text = stripComments(file.text);
    assert.ok(!/require\(|node:|eraseItem|ipcRenderer/.test(text), `${file.rel} reaches past the bridge`);
  }
  const preload = code("electron/preload.cjs");
  assert.ok(!/\bpath\b/.test(preload.replace(/\/\*[\s\S]*?\*\//g, "")), "the bridge takes a path somewhere");
});

test("audit: no network anywhere", () => {
  const hits = shipped.filter((file) => /\bfetch\s*\(|node:https?|node:net|XMLHttpRequest|WebSocket/.test(stripComments(file.text))).map((file) => file.rel);
  assert.deepEqual(hits, []);
});

// ── pure rules ──────────────────────────────────────────────────────────────

test("guard: drive roots, the home folder, its parents and shallow paths are refused", () => {
  const { root } = parse(process.cwd());
  assert.ok(guardPath(root));
  assert.ok(guardPath(homedir()));
  assert.ok(guardPath(dirname(homedir())));
  assert.ok(guardPath(join(root, "projects")));
  assert.equal(guardPath(join(root, "projects", "app", "node_modules")), null);
  assert.ok(guardPath(""));
});

test("verdict: no combination with committed files or without an owner is selectable", () => {
  const claims = [
    null,
    { stack: { label: "Node.js" }, artifact: { strength: "strong", markers: [".package-lock.json"] } },
    { stack: { label: "Node.js" }, artifact: { strength: "tool" } },
    { stack: { label: "Python" }, artifact: { strength: "strong", markers: ["pyvenv.cfg"], required: true } },
  ];
  const gits = [
    { state: "none" },
    { state: "unavailable" },
    { state: "error" },
    ...[0, 3, null].flatMap((tracked) =>
      [true, false, null].map((ignored) => ({ state: "ok", tracked, ignore: ignored == null ? null : { ignored, source: ".gitignore", line: 1, pattern: "x/" } })),
    ),
  ];
  let combos = 0;
  for (const claim of claims) {
    for (const runtime of [false, true]) {
      for (const marker of [null, "marker"]) {
        for (const git of gits) {
          combos += 1;
          const { tier } = judge({ name: "x", claim, runtime, marker, git, manifest: "package.json", projectName: "p" });
          const label = JSON.stringify({ claim: Boolean(claim), runtime, marker, git });
          if (git.state === "ok" && (git.tracked > 0 || git.tracked == null)) assert.equal(tier, "blocked", label);
          const committedOrUnknown = git.state === "ok" && git.tracked !== 0;
          if (!claim && !runtime && !committedOrUnknown) assert.equal(tier, marker ? "review" : "blocked", label);
          if (!claim) assert.notEqual(tier, "safe", label);
          if (runtime) assert.notEqual(tier, "safe", label);
          if (claim?.artifact.required && !marker && !runtime) assert.equal(tier, "blocked", label);
          const strong = Boolean(marker) && claim?.artifact.strength === "strong";
          if (git.state === "ok" && git.ignore?.ignored === false && !strong) assert.notEqual(tier, "safe", label);
          if (git.state !== "ok" && !strong) assert.notEqual(tier, "safe", label);
        }
      }
    }
  }
  assert.ok(combos >= 192, `only ${combos}`);
});

await testAsync("stacks: build belongs to whoever writes it", async () => {
  const cra = await describeProject("x", ["package.json"], async () => ({ dependencies: { "react-scripts": "5" } }));
  assert.equal(claimFor(cra, detectStacks(cra), "build")?.stack.id, "node");
  assert.equal(claimFor(cra, detectStacks(cra), "dist"), null, "CRA does not write dist");
  const plain = await describeProject("x", ["package.json"], async () => ({ dependencies: { lodash: "4" } }));
  assert.equal(claimFor(plain, detectStacks(plain), "build"), null, "a plain package does not own build");
  assert.equal(claimFor(plain, detectStacks(plain), "lib"), null, "lib is source unless tsc says otherwise");
  const tsc = await describeProject("x", ["package.json", "tsconfig.json"], async (name) =>
    name === "tsconfig.json" ? { compilerOptions: { outDir: "./lib/" } } : {},
  );
  assert.equal(claimFor(tsc, detectStacks(tsc), "lib")?.stack.id, "node");
});

test("toolchains are recognised by their contents", () => {
  assert.ok(toolchainFor(["node.exe", "npm.cmd", "node_modules"]));
  assert.ok(toolchainFor(["emsdk.py", "upstream"]));
  assert.ok(toolchainFor(["platform-tools", "build-tools"]));
  assert.equal(toolchainFor(["package.json", "node_modules", "src"]), null);
  assert.equal(toolchainFor(["node", "src"]), null);
});

test("skips: installed software and extensions are never entered, a project's own windows/ folder is", () => {
  assert.ok(skipFor("C:\\Users\\x\\AppData"));
  assert.ok(skipFor("D:\\apps\\Slack\\resources\\app.asar.unpacked\\x", { scanRoot: "D:\\apps" }));
  assert.ok(skipFor("D:\\code\\.vscode"));
  assert.ok(skipFor("E:\\work\\emsdk"));
  assert.ok(skipFor("C:\\Program Files"));
  assert.ok(skipFor("C:\\Windows"));
  assert.equal(skipFor("E:\\code\\flutter_app\\windows"), null);
  assert.equal(skipFor("E:\\code\\app\\src"), null);
});

test("removal: blocked rows and unknown ids are refused, batches are capped", () => {
  const items = [
    { id: "i1", tier: "safe", bytes: 10, relPath: "a" },
    { id: "i2", tier: "blocked", bytes: 10, relPath: "b", reason: "committed" },
    { id: "i3", tier: "review", kind: "runtime", bytes: 10, relPath: "c" },
  ];
  const { removable, refused } = selectRemovable(items, ["i1", "i2", "i3", "i9"]);
  assert.deepEqual(removable.map((item) => item.id), ["i1", "i3"]);
  assert.deepEqual(refused.map((entry) => entry.id).sort(), ["i2", "i9"]);
  assert.ok(describeRemoval(removable).warnings.some((line) => /runtime data/.test(line)));
  const many = Array.from({ length: MAX_BATCH + 5 }, (_, index) => ({ id: `m${index}`, tier: "safe", bytes: 1 }));
  assert.equal(selectRemovable(many, many.map((item) => item.id)).removable.length, MAX_BATCH);
});

// ── fixtures ────────────────────────────────────────────────────────────────

const base = mkdtempSync(join(tmpdir(), "stacksweep-check-"));
const hasGit = await gitAvailable();

function put(rel, content = "x".repeat(64)) {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function git(dir, ...args) {
  execFileSync("git", ["-c", "user.name=check", "-c", "user.email=check@example.invalid", "-c", "core.autocrlf=false", ...args], {
    cwd: join(base, dir),
    stdio: "ignore",
  });
}

// A Next + Vite web app in its own repository.
put("web/package.json", { name: "web", dependencies: { next: "15", react: "19" }, devDependencies: { vite: "6" } });
put("web/.gitignore", "node_modules/\n.next/\ndist/\nuploads/\n");
put("web/src/index.js", "export {}");
put("web/node_modules/.package-lock.json", "{}");
put("web/node_modules/react/index.js");
put("web/node_modules/react/node_modules/inner/index.js"); // nested: counted once, never listed
put("web/.next/BUILD_ID", "abc");
put("web/dist/bundle.js");
put("web/uploads/video.mp4", "v".repeat(4096));

// A library whose dist is committed -- vendored code that happens to be called dist.
put("lib/package.json", { name: "lib", devDependencies: { rollup: "4" } });
put("lib/dist/lib.min.js");
put("lib/index.js");

// A CRA app outside any repository: tool-only evidence.
put("cra/package.json", { name: "cra", dependencies: { "react-scripts": "5" } });
put("cra/build/index.html");

// A package outside any repository, with a lockfile marker in node_modules.
put("plain/package.json", { name: "plain" });
put("plain/node_modules/.package-lock.json", "{}");
put("plain/node_modules/x/index.js");

// The Node that ships inside emsdk, and a Node install found by its contents.
put("emsdk/node/20.18.0_64bit/bin/node.exe");
put("emsdk/node/20.18.0_64bit/bin/node_modules/npm/package.json", { name: "npm" });
put("tools/nodejs/node.exe");
put("tools/nodejs/npm.cmd");
put("tools/nodejs/node_modules/npm/package.json", { name: "npm" });

// An editor extension's own dependencies.
put("home/.vscode/extensions/foo/package.json", { name: "foo" });
put("home/.vscode/extensions/foo/node_modules/.package-lock.json", "{}");

// A build folder no project claims, and a venv with no requirements beside it.
put("orphan/build/thing.bin");
put("stray/.venv/pyvenv.cfg", "home = x");
put("stray/.venv/Lib/site.py");

// An Android module: build and .cxx are Gradle's, the build inside .cxx is not a row of its own.
put("mobile/android/build.gradle", "");
put("mobile/android/settings.gradle", "");
put("mobile/android/.gitignore", "build/\n.gradle/\n.cxx/\n");
put("mobile/android/app/build.gradle", "");
put("mobile/android/app/build/intermediates/x.dex");
put("mobile/android/app/.cxx/Debug/abc/arm64/CMakeFiles/app.dir/build/obj.o");

// Python in a repository: a venv, scattered __pycache__, and a venv that is not one.
put("py/requirements.txt", "requests\n");
put("py/.gitignore", "__pycache__/\n.venv/\n");
put("py/.venv/pyvenv.cfg", "home = x");
put("py/.venv/Lib/site.py");
put("py/pkg/__init__.py");
put("py/pkg/__pycache__/a.cpython-312.pyc");
put("py/pkg/sub/__pycache__/b.cpython-312.pyc");
put("py2/requirements.txt", "flask\n");
put("py2/venv/notes.txt", "my own notes, not an environment");

if (hasGit) {
  git("web", "init", "-q");
  git("web", "add", "-A");
  git("web", "commit", "-q", "-m", "init");
  git("lib", "init", "-q");
  git("lib", "add", "-A");
  git("lib", "commit", "-q", "-m", "init");
  git("mobile/android", "init", "-q");
  git("mobile/android", "add", "-A");
  git("mobile/android", "commit", "-q", "-m", "init");
  git("py", "init", "-q");
  git("py", "add", "-A");
  git("py", "commit", "-q", "-m", "init");
}

const result = await scan({
  targets: [{ id: "t", path: base, label: "fixture" }],
  limits: { minItemBytes: 1, runtimeMinBytes: 1, unclaimedMinBytes: 1 },
});
const rel = (item) => relative(base, item.type === "set" ? join(item.path, item.artifactName) : item.path).replace(/\\/g, "/");
const byRel = new Map(result.items.map((item) => [rel(item), item]));
const tierOf = (path) => byRel.get(path)?.tier ?? "(not listed)";

console.log(`     fixture scan: ${result.items.length} items, ${result.stats.projectsSeen} projects, git ${hasGit ? "on" : "off"}`);

test("fixture: a project's node_modules with a lockfile marker is safe", () => {
  assert.equal(tierOf("web/node_modules"), hasGit ? "safe" : "safe");
  assert.equal(tierOf("plain/node_modules"), "safe");
});

test("fixture: every project gets its own id, even when walked in parallel", () => {
  const byId = new Map();
  for (const item of result.items) {
    if (!item.project) continue;
    const dirs = byId.get(item.project.id) ?? new Set();
    dirs.add(item.project.dir);
    byId.set(item.project.id, dirs);
  }
  for (const [id, dirs] of byId) assert.equal(dirs.size, 1, `${id} is shared by ${[...dirs].join(", ")}`);
});

test("fixture: nested node_modules are counted inside their parent, never listed", () => {
  assert.equal(byRel.has("web/node_modules/react/node_modules"), false);
});

test("fixture: .next and Vite's dist are safe when git ignores them", () => {
  if (!hasGit) return;
  assert.equal(tierOf("web/.next"), "safe");
  assert.equal(tierOf("web/dist"), "safe");
});

test("fixture: a dist with committed files is blocked", () => {
  if (!hasGit) return;
  assert.equal(tierOf("lib/dist"), "blocked");
  assert.match(byRel.get("lib/dist").reason, /committed/);
});

test("fixture: CRA build outside a repository is only review", () => {
  assert.equal(tierOf("cra/build"), "review");
});

test("fixture: emsdk's Node, a Node install and an editor extension are never listed", () => {
  for (const [path] of byRel) {
    assert.ok(!path.startsWith("emsdk/"), path);
    assert.ok(!path.startsWith("tools/"), path);
    assert.ok(!path.startsWith("home/"), path);
  }
  assert.ok(result.skipped.some((rule) => rule.id === "toolchain"));
  assert.ok(result.skipped.some((rule) => rule.id === "toolchain-contents"));
  assert.ok(result.skipped.some((rule) => rule.id === "editor-extensions"));
});

test("fixture: a build folder nobody owns is blocked, an orphan venv with pyvenv.cfg is only review", () => {
  assert.equal(tierOf("orphan/build"), "blocked");
  assert.equal(tierOf("stray/.venv"), "review");
});

test("fixture: Gradle's build and .cxx are found, the build inside .cxx is not a row", () => {
  assert.equal(tierOf("mobile/android/app/build"), hasGit ? "safe" : "review");
  assert.equal(tierOf("mobile/android/app/.cxx"), hasGit ? "safe" : "review");
  assert.ok(![...byRel.keys()].some((path) => path.includes(".cxx/")));
});

test("fixture: ignored runtime data is review, never safe", () => {
  assert.equal(tierOf("web/uploads"), "review");
  assert.equal(byRel.get("web/uploads").kind, "runtime");
});

test("fixture: a venv is safe, a folder called venv without pyvenv.cfg is blocked", () => {
  assert.equal(tierOf("py/.venv"), "safe");
  assert.equal(tierOf("py2/venv"), "blocked");
});

test("fixture: scattered __pycache__ becomes one row naming each folder", () => {
  const set = byRel.get("py/__pycache__");
  assert.ok(set, "no __pycache__ row");
  assert.equal(set.type, "set");
  assert.equal(set.members.length, 2);
  if (hasGit) assert.equal(set.tier, "safe");
});

await testAsync("reverify: refuses once a file inside has been committed", async () => {
  if (!hasGit) return;
  const item = byRel.get("web/dist");
  assert.equal(await reverify(item, [base]), null);
  git("web", "add", "-f", "dist/bundle.js");
  assert.match(await reverify(item, [base]), /committed/);
  git("web", "rm", "-q", "--cached", "dist/bundle.js");
  assert.equal(await reverify(item, [base]), null);
});

await testAsync("reverify: refuses outside the scanned folders and when the marker is gone", async () => {
  const item = byRel.get("plain/node_modules");
  assert.match(await reverify(item, [join(base, "web")]), /not inside/);
  const fake = { ...item, marker: "not-there.json" };
  assert.match(await reverify(fake, [base]), /no longer inside/);
});

await testAsync("erase: a folder goes, its project stays, and progress is reported as it goes", async () => {
  const item = byRel.get("plain/node_modules");
  for (let index = 0; index < 40; index += 1) put(`plain/node_modules/pkg${index}/index.js`);
  const seen = [];
  await eraseItem(item, { onProgress: (done, of) => seen.push([done, of]) });
  assert.equal(existsSync(join(base, "plain/node_modules")), false);
  assert.equal(existsSync(join(base, "plain/package.json")), true);
  assert.ok(seen.length > 10, `only ${seen.length} progress calls`);
  const [lastDone, lastOf] = seen.at(-1);
  assert.equal(lastDone, lastOf);
});

await testAsync("erase: Stop leaves the folder partly deleted and says so", async () => {
  for (let index = 0; index < 60; index += 1) put(`stopme/node_modules/pkg${index}/index.js`);
  const controller = new AbortController();
  const item = { type: "folder", path: join(base, "stopme/node_modules") };
  await assert.rejects(
    eraseItem(item, { signal: controller.signal, onProgress: (done) => done >= 5 && controller.abort() }),
    (error) => error.stopped === true,
  );
  assert.equal(existsSync(join(base, "stopme/node_modules")), true, "the folder itself should still be there");
});

await testAsync("long paths: a node_modules nested past 260 characters is scanned and deleted completely", async () => {
  // npm 2-style nesting: every package carries its own node_modules, so the
  // deepest file sits far beyond MAX_PATH -- where Explorer and plain `rd` fail.
  const project = join(base, "deep-app");
  put("deep-app/package.json", { name: "deep-app" });
  put("deep-app/src/index.js", "keep me");
  put("deep-app/node_modules/.package-lock.json", "{}");
  let rel = "deep-app/node_modules";
  for (let level = 0; level < 14; level += 1) {
    rel += `/some-long-package-name-${level}/node_modules`;
    put(`${rel}/../index.js`);
  }
  put(`${rel}/leaf-package/index.js`, "deepest file");
  const deepest = join(base, rel, "leaf-package", "index.js");
  assert.ok(deepest.length > 600, `deepest path is only ${deepest.length} characters`);
  assert.equal(existsSync(deepest), true);

  const scanned = await scan({ targets: [{ id: "deep", path: project, label: "deep" }], limits: { minItemBytes: 1 } });
  const item = scanned.items.find((entry) => entry.artifactName === "node_modules");
  assert.ok(item, "node_modules was not found");
  assert.equal(item.tier, "safe");
  assert.ok(item.files >= 16, `only ${item.files} files counted — the deep ones were missed`);
  assert.equal(item.truncated, false, "the measurement stopped short");

  await eraseItem(item);
  assert.equal(existsSync(join(project, "node_modules")), false, "node_modules is still there");
  assert.equal(existsSync(join(project, "src", "index.js")), true, "the project's own files were touched");
});

await testAsync("erase: a set removes its members by name and never the project folder", async () => {
  const set = byRel.get("py/__pycache__");
  await eraseItem(set);
  assert.equal(existsSync(join(base, "py/pkg/__pycache__")), false);
  assert.equal(existsSync(join(base, "py/pkg/sub/__pycache__")), false);
  assert.equal(existsSync(join(base, "py/pkg/__init__.py")), true);
  assert.equal(existsSync(join(base, "py/requirements.txt")), true);
  await assert.rejects(eraseItem({ ...set, members: [join(base, "py/pkg")] }), /not a __pycache__ folder/);
  await assert.rejects(eraseItem({ ...set, membersComplete: false }), /too many/);
});

rmSync(base, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
