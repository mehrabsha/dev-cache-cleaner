/**
 * Places not worth walking into -- or not safe to.
 *
 * Copied from disk-janitor's skip list, with one change of purpose. There it
 * only saved time. Here it is also the first safety rail: a `node_modules`
 * inside a VS Code extension, a global npm install, an Electron app's
 * `resources\app`, or the Node that ships inside emsdk all *look* exactly like
 * a project's dependencies -- same name, same lockfile markers, sometimes a
 * package.json right beside them -- and deleting any of them breaks installed
 * software rather than freeing a cache.
 *
 * So those trees are never entered at all. A skip is counted and named in the
 * report, so a sweep that declined half a drive cannot look like a sweep that
 * found nothing there.
 */

import { basename } from "node:path";

/** Matched against a lowercase, forward-slashed path with a trailing slash. */
const WINDOWS_SKIPS = [
  // `windows` only at the top of a drive: Flutter and React Native projects
  // have a `windows` folder of their own, and it is source.
  { id: "windows-system", why: "Operating system files.", patterns: [/^[a-z]:\/windows\//], segments: ["system32", "syswow64", "winsxs", "servicing", "driverstore", "systemapps"] },
  { id: "windows-store", why: "Store app payloads, managed by Windows.", segments: ["windowsapps", "$windows.~bt", "$windows.~ws", "winreagent"] },
  { id: "volume-metadata", why: "Filesystem bookkeeping, not files.", segments: ["system volume information", "$recycle.bin", "$sysreset", "config.msi", "recovery", "documents and settings", "msocache", "programdata"] },
  { id: "app-data", why: "Installed apps keep their own node_modules and builds here — deleting them breaks the app, it does not free a cache.", segments: ["appdata"] },
  { id: "swap", why: "Paging and hibernation files, owned by the kernel.", names: ["pagefile.sys", "hiberfil.sys", "swapfile.sys"] },
];

/** Not tied to a Windows system folder, but just as unsafe to walk into. */
const COMMON_SKIPS = [
  { id: "installed-software", why: "Installed software — its own node_modules are not a project's.", segments: ["program files", "program files (x86)"] },
  // Only names nobody gives a project. Toolchains with ordinary-looking names
  // (a Node distribution, an Android SDK) are recognised by what is inside
  // them instead -- see `toolchainFor` in scan.js.
  {
    id: "toolchain",
    why: "An SDK or toolchain install (emsdk, nvm, rustup, conda…). Its node_modules and builds are part of the tool.",
    segments: ["emsdk", ".nvm", ".rustup", ".cargo", ".pyenv", "miniconda3", "anaconda3", ".conda", ".sdkman", "scoop", "chocolatey", ".bun", ".deno", ".volta", ".fnm", ".pub-cache"],
    contains: ["/android/sdk/", "/go/pkg/mod/"],
  },
  {
    id: "global-packages",
    why: "Globally installed packages — deleting them removes CLI tools, not caches.",
    contains: ["/npm/node_modules/", "/lib/node_modules/", "/site-packages/", "/dist-packages/", "/.m2/repository/", "/.gradle/caches/", "/.nuget/packages/", "/pnpm/store/"],
  },
  {
    id: "editor-extensions",
    why: "Editor and browser extensions ship their node_modules and builds as part of themselves.",
    segments: [".vscode", ".vscode-insiders", ".vscode-server", ".cursor", ".windsurf", ".antigravity", ".kiro"],
  },
  { id: "packaged-app", why: "A packaged Electron app — its node_modules are what it runs on.", segments: ["resources"], contains: [".asar.unpacked/", "/resources/app/"] },
  { id: "vcs-internals", why: "Version control internals — never junk.", segments: [".git", ".hg", ".svn"] },
  { id: "sync-roots", why: "A sync root; deleting here deletes on every other device too.", segments: ["onedrive", "dropbox", "google drive", "icloud drive", "nextcloud", "mega"] },
  { id: "vm-images", why: "Virtual machine storage.", suffixes: [".vmwarevm", ".vbox"], segments: ["virtualbox vms", ".virtualbox"] },
];

const SKIPS = [...WINDOWS_SKIPS, ...COMMON_SKIPS];

/** Fold to a comparable shape: lowercase, forward slashes, trailing slash. */
function fold(path) {
  return `${path.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "")}/`;
}

/**
 * Should the walk decline to enter this directory?
 *
 * Only the *last* segment is tested against `segments`, plus `contains` and
 * `patterns` against the whole path. Testing every ancestor would make a scan
 * started inside, say, `D:\resources\my-app` decline everything in it; the
 * folder a person explicitly picked is theirs to have scanned.
 */
export function skipFor(path, { scanRoot = null } = {}) {
  const folded = fold(path);
  const name = basename(folded.slice(0, -1));
  // Below the picked folder only: the picked folder and its ancestors are a choice, not a finding.
  const below = scanRoot ? folded.slice(fold(scanRoot).length - 1) : folded;

  for (const rule of SKIPS) {
    if (rule.names?.includes(name)) return rule;
    if (rule.suffixes?.some((suffix) => name.endsWith(suffix))) return rule;
    if (rule.patterns?.some((pattern) => pattern.test(folded))) return rule;
    if (rule.segments?.includes(name)) return rule;
    if (rule.contains?.some((fragment) => below.includes(fragment))) return rule;
  }
  return null;
}

/** For the window and the report: what this build declines, and why. */
export function describeSkips() {
  return SKIPS.map(({ id, why }) => ({ id, why }));
}
