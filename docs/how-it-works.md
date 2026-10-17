# How StackSweep works

StackSweep offers to delete only what **a project's own stack writes and would
write again**. This page is the long version: the rules, the tiers, and the
safety rails the self-check enforces. Every verdict comes from rules you can
read in [`src/stacks.js`](../src/stacks.js) and
[`src/verdict.js`](../src/verdict.js).
## Why name-matching is not enough

The rules were written after cleaning real disks by hand, where every one of
these looked deletable and was not:

| Looked like junk | Actually was |
| --- | --- |
| `GDevelop\Extensions\…\dist` | vendored libraries, **committed** to git |
| `telegram-tt\dist` | 10,482 committed files |
| `emsdk\node\…\bin\node_modules` | npm itself, inside the Emscripten SDK |
| `.vscode\extensions\…\node_modules` | an extension's runtime |
| `electron-app\app\extensions\ReactDeveloperTools\…\build` | a vendored browser extension |
| `android\app\.cxx\…\build` | part of the CMake cache, not its own thing |
| a `build` with no `package.json` near it | nobody knows — so nobody deletes it |

## How a verdict is reached

```
walk     at every directory: which stacks is this the root of?
         (package.json + next → Next.js, build.gradle → Gradle, Cargo.toml → Rust …)
         a child that one of those stacks owns becomes a candidate and is NOT entered,
         so nested node_modules count once, inside their parent
measure  size each candidate whole; symlinks and junctions are never followed
git      one check-ignore and one ls-files per repository, batched
judge    evidence → safe / review / blocked
```

| Tier | Means | Selectable |
| --- | --- | --- |
| **Safe** | a detected stack owns it, nothing inside is committed, and git ignores it *or* a marker only a tool writes is inside (`.package-lock.json`, `CACHEDIR.TAG`, `pyvenv.cfg`, `BUILD_ID` …) | yes, and "Select all safe" |
| **Review** | probably regenerable but the evidence is thinner (not ignored, no repo, a `dist` with only tool evidence) — or **runtime data**: large gitignored `uploads`, `logs`, `renders` … which do *not* come back | by hand only |
| **Blocked** | committed files inside, no project owns it, or it lacks what its name implies (a `venv` without `pyvenv.cfg`) | never |

The rules run most-conservative-first, so adding a rule can only push a
verdict towards Blocked. The self-check runs every combination of evidence and
asserts that nothing with committed files, and nothing without an owner, comes
out Safe.

Every row carries its evidence — which manifest claimed it, which marker is
inside, which `.gitignore` line ignores it, how many files are committed — and
the command that brings it back.

### Stacks

Node (npm / pnpm / yarn / bun), Next.js, Nuxt, SvelteKit, Astro, Angular,
Docusaurus, Gatsby, Expo, Vite / CRA / tsc / Turbo / Parcel output, Gradle /
Android, CocoaPods, Maven, Rust, Python, .NET, Flutter / Dart, Composer,
Bundler, CMake, Unity, Godot, Swift Package, Zig, Elixir, Haskell.

A `dist` is only claimed when a tool in that project writes `dist` (Vite,
webpack, Rollup, tsup, electron-builder …); `build` only for CRA, Docusaurus,
SvelteKit and friends; `lib` only when `tsconfig.json` says `outDir: lib`.

### Never entered

System folders, `AppData`, Program Files, editor extension
folders, packaged Electron apps (`resources\app`, `.asar.unpacked`), global
package stores, sync roots (OneDrive, Dropbox …), and SDK / toolchain installs
— recognised by name (`emsdk`, `.nvm`, `.rustup` …) **and by contents** (a
folder holding `node.exe` + `npm.cmd`, `emsdk.py`, `platform-tools`). The
report lists every rule that declined something, with a count and an example.

## Deleting

- **By id, never by path.** The window asks for `i7`; main looks it up in the
  scan the window was shown. A folder picked in the native dialog is kept in
  main too — the window only ever holds an id for it.
- **Blocked is refused in main**, whatever the UI drew.
- **A native confirmation**, Cancel by default, that says "cannot be undone"
  up front and names what you may not have noticed: Review rows, runtime data,
  projects worked on in the last 7 days (a dev server can hold files locked).
- **Re-verified right before each `rm`.** A scan can be half an hour old. Each
  item is checked again: still a plain folder (not swapped for a junction),
  still named what it was, still inside a scanned folder, its marker still
  there, and `git ls-files` still showing nothing committed.
- **Scattered `__pycache__`** is one row per project, removed member by member
  by exact name — never the project folder it points at.
- A locked folder stays in red with the reason: *Locked (EBUSY) — close the
  dev server, IDE or emulator and try again.*

## The rails the self-check enforces

- Exactly one file removes anything — [`src/erase.js`](../src/erase.js). It
  imports exactly `{ rm }`, calls it at exactly two sites, both with
  `ERASE_OPTIONS`, and only `electron/main.js` imports it. Every other shipped
  file is grepped for `unlink`, `rm(`, `writeFile`, `rename`, `mkdir` … and
  fails the check on a hit.
- Exactly one file starts a process — [`src/git.js`](../src/git.js), with
  `execFile` (an argument array, no shell), fixed subcommands, and paths over
  stdin or after `--`.
- Every filesystem import is enumerated and asserted verbatim: `scan.js`
  `{ readdir, lstat }`, `manifest.js` `{ readFile }` (only `package.json` and
  `tsconfig.json`, capped at 1 MB), `roots.js` `{ statfs }`.
- The window is opened with `contextIsolation`, no `nodeIntegration`, and
  `sandbox`; nothing in `app/` contains `require`, `node:` or the eraser.
- No `fetch`, `http`, `net` or sockets anywhere.
- Fixture trees for every trap in the table above are built in the temp
  folder, scanned, asserted, then deleted for real — checking the bystanders
  survive.

## Layout

```
electron/main.js      window, native dialogs, the delete handler
electron/preload.cjs  the bridge: 11 named calls, none takes a path
src/stacks.js         stacks, artifacts, markers, regenerate commands
src/scan.js           walk, measure, ask git, judge
src/verdict.js        evidence → safe / review / blocked (pure)
src/git.js            check-ignore and ls-files (the one subprocess)
src/manifest.js       reads package.json / tsconfig.json
src/skips.js          where the walk never goes
src/removal.js        select by id, describe, re-verify
src/erase.js          the one file that deletes
src/cli.js            terminal dry run
src/selftest.js       audits + fixtures
app/                  the window (HTML, CSS, one ES module)
```
