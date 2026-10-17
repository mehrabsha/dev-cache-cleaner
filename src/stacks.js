/**
 * What a project is, and what it is allowed to throw away.
 *
 * A folder called `build` is not junk because of its name. It is junk because
 * a tool this project uses writes it, and would write it again. So nothing
 * here matches names on their own: every artifact belongs to a *stack*, a
 * stack is detected from the manifest files sitting in a directory, and an
 * artifact is only ever proposed for the project whose stack owns it.
 *
 * Each artifact carries:
 *
 *   name       the directory name, exactly (or `prefix` for `cmake-build-*`)
 *   kind       what sort of thing it is, for grouping in the window
 *   markers    files or folders inside it that prove it was generated --
 *              `.package-lock.json`, `CACHEDIR.TAG`, `pyvenv.cfg`. A marker is
 *              the strongest evidence this project has, because no person
 *              writes one by hand
 *   strength   "strong" when a marker settles it alone; "tool" when the only
 *              evidence is that the project's tooling outputs there (a `dist`
 *              is just a folder; its owner is what makes it disposable)
 *   regen      the command that puts it back, shown in the inspector
 *   when       an optional condition on the project -- `.next` only for a
 *              project that actually depends on Next
 *
 * `scattered` artifacts (`__pycache__`) are owned by the nearest ancestor
 * project rather than the directory they sit in, and are gathered into one
 * row per project rather than one row each.
 */

export const KINDS = {
  deps: { id: "deps", label: "Dependencies", blurb: "Installed packages. Your package manager puts them back." },
  build: { id: "build", label: "Build output", blurb: "What a build wrote. The next build writes it again." },
  cache: { id: "cache", label: "Tool caches", blurb: "Caches a framework or tool keeps to go faster next time." },
  native: { id: "native", label: "Native builds", blurb: "Android, iOS and C++ intermediates." },
  venv: { id: "venv", label: "Virtual environments", blurb: "Python environments, recreated from requirements." },
  runtime: { id: "runtime", label: "Runtime data", blurb: "Uploads, logs and temp files an app wrote while running. Not regenerable — look before you delete." },
  unknown: { id: "unknown", label: "Unclaimed", blurb: "Has a cleanup-shaped name, but no project here owns it." },
};

/** Dependency names that put a build tool's output in a known place. */
const has = (...names) => (project) => names.some((name) => project.deps.has(name));
const hasFile = (...names) => (project) => names.some((name) => project.files.has(name.toLowerCase()));
const either = (...tests) => (project) => tests.some((test) => test(project));

const NODE_DIST_TOOLS = [
  "vite", "webpack", "rollup", "tsup", "esbuild", "parcel", "electron-builder", "electron-vite",
  "@angular/cli", "@angular-devkit/build-angular", "astro", "microbundle", "unbuild", "@vercel/ncc",
  "vue-cli-service", "@vue/cli-service", "expo", "electron-forge", "@electron-forge/cli",
];
const NODE_BUILD_TOOLS = ["react-scripts", "@docusaurus/core", "@sveltejs/kit", "@remix-run/dev", "react-app-rewired", "craco", "@craco/craco"];

export const STACKS = [
  {
    id: "node",
    label: "Node.js",
    manifests: ["package.json"],
    artifacts: [
      {
        name: "node_modules",
        kind: "deps",
        strength: "strong",
        markers: [".package-lock.json", ".modules.yaml", ".yarn-state.yml", ".yarn-integrity", ".pnpm", ".bin"],
        regen: (project) => `${project.packageManager} install`,
      },
      {
        name: "dist",
        kind: "build",
        strength: "tool",
        when: either(has(...NODE_DIST_TOOLS), (project) => project.tsOutDir === "dist"),
        regen: (project) => `${project.packageManager} run build`,
      },
      {
        name: "build",
        kind: "build",
        strength: "tool",
        when: either(has(...NODE_BUILD_TOOLS), (project) => project.tsOutDir === "build"),
        regen: (project) => `${project.packageManager} run build`,
      },
      {
        name: "out",
        kind: "build",
        strength: "tool",
        when: either(has("next", "electron-forge", "@electron-forge/cli"), (project) => project.tsOutDir === "out"),
        regen: (project) => `${project.packageManager} run build`,
      },
      {
        name: "lib",
        kind: "build",
        strength: "tool",
        // Only when tsc says so -- `lib` is a source folder far more often than not.
        when: (project) => project.tsOutDir === "lib",
        regen: (project) => `${project.packageManager} run build`,
      },
      { name: ".turbo", kind: "cache", strength: "tool", when: has("turbo"), regen: () => "rebuilt by turbo" },
      { name: ".parcel-cache", kind: "cache", strength: "tool", when: has("parcel"), regen: () => "rebuilt by parcel" },
      { name: ".vite", kind: "cache", strength: "tool", when: has("vite"), regen: () => "rebuilt by vite" },
      {
        name: "coverage",
        kind: "build",
        strength: "tool",
        when: has("jest", "vitest", "nyc", "c8", "@vitest/coverage-v8", "karma"),
        markers: ["lcov.info", "coverage-final.json", "lcov-report", "clover.xml"],
        regen: (project) => `${project.packageManager} test -- --coverage`,
      },
      { name: "storybook-static", kind: "build", strength: "tool", when: has("storybook", "@storybook/react", "@storybook/cli"), regen: () => "storybook build" },
    ],
  },
  {
    id: "next",
    label: "Next.js",
    manifests: ["package.json"],
    when: either(has("next"), hasFile("next.config.js", "next.config.mjs", "next.config.ts")),
    artifacts: [
      {
        name: ".next",
        kind: "cache",
        strength: "strong",
        markers: ["BUILD_ID", "build-manifest.json", "cache", "trace", "server", "types", "dev"],
        regen: (project) => `${project.packageManager} run build`,
      },
    ],
  },
  {
    id: "nuxt",
    label: "Nuxt",
    manifests: ["package.json"],
    when: has("nuxt", "nuxt3"),
    artifacts: [
      { name: ".nuxt", kind: "cache", strength: "tool", regen: () => "nuxt prepare" },
      { name: ".output", kind: "build", strength: "tool", regen: () => "nuxt build" },
    ],
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    manifests: ["package.json"],
    when: has("@sveltejs/kit"),
    artifacts: [{ name: ".svelte-kit", kind: "cache", strength: "tool", regen: () => "svelte-kit sync" }],
  },
  {
    id: "astro",
    label: "Astro",
    manifests: ["package.json"],
    when: has("astro"),
    artifacts: [{ name: ".astro", kind: "cache", strength: "tool", regen: () => "astro sync" }],
  },
  {
    id: "angular",
    label: "Angular",
    manifests: ["angular.json"],
    artifacts: [{ name: ".angular", kind: "cache", strength: "tool", regen: () => "ng build" }],
  },
  {
    id: "docusaurus",
    label: "Docusaurus",
    manifests: ["package.json"],
    when: has("@docusaurus/core"),
    artifacts: [{ name: ".docusaurus", kind: "cache", strength: "tool", regen: () => "docusaurus build" }],
  },
  {
    id: "gatsby",
    label: "Gatsby",
    manifests: ["package.json"],
    when: has("gatsby"),
    artifacts: [
      { name: ".cache", kind: "cache", strength: "tool", regen: () => "gatsby build" },
      { name: "public", kind: "build", strength: "tool", regen: () => "gatsby build" },
    ],
  },
  {
    id: "expo",
    label: "Expo",
    manifests: ["package.json"],
    when: has("expo"),
    artifacts: [
      { name: ".expo", kind: "cache", strength: "tool", regen: () => "expo start" },
      { name: "web-build", kind: "build", strength: "tool", regen: () => "expo export" },
    ],
  },
  {
    id: "gradle",
    label: "Gradle",
    manifests: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    artifacts: [
      {
        name: "build",
        kind: "native",
        strength: "strong",
        markers: ["intermediates", "tmp", "generated", "outputs", "kotlin", "classes", "libs", "reports"],
        regen: () => "./gradlew assemble",
      },
      { name: ".gradle", kind: "cache", strength: "tool", regen: () => "recreated by Gradle" },
      { name: ".cxx", kind: "native", strength: "tool", regen: () => "recreated by the next native build" },
      { name: ".externalNativeBuild", kind: "native", strength: "tool", regen: () => "recreated by the next native build" },
    ],
  },
  {
    id: "cocoapods",
    label: "CocoaPods",
    manifests: ["Podfile"],
    artifacts: [
      { name: "Pods", kind: "deps", strength: "strong", markers: ["Manifest.lock"], regen: () => "pod install" },
      { name: "build", kind: "native", strength: "tool", regen: () => "xcodebuild" },
    ],
  },
  {
    id: "maven",
    label: "Maven",
    manifests: ["pom.xml"],
    artifacts: [
      {
        name: "target",
        kind: "build",
        strength: "strong",
        markers: ["maven-status", "classes", "maven-archiver", "test-classes"],
        regen: () => "mvn package",
      },
    ],
  },
  {
    id: "rust",
    label: "Rust",
    manifests: ["Cargo.toml"],
    artifacts: [
      { name: "target", kind: "build", strength: "strong", markers: ["CACHEDIR.TAG", ".rustc_info.json"], regen: () => "cargo build" },
    ],
  },
  {
    id: "python",
    label: "Python",
    manifests: ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.py", "setup.cfg", "Pipfile", "poetry.lock", "uv.lock"],
    artifacts: [
      { name: ".venv", kind: "venv", strength: "strong", markers: ["pyvenv.cfg"], required: true, regen: () => "python -m venv .venv && pip install -r requirements.txt" },
      { name: "venv", kind: "venv", strength: "strong", markers: ["pyvenv.cfg"], required: true, regen: () => "python -m venv venv && pip install -r requirements.txt" },
      { name: "env", kind: "venv", strength: "strong", markers: ["pyvenv.cfg"], required: true, regen: () => "python -m venv env" },
      { name: ".tox", kind: "venv", strength: "tool", regen: () => "tox" },
      { name: ".nox", kind: "venv", strength: "tool", regen: () => "nox" },
      { name: ".pytest_cache", kind: "cache", strength: "strong", markers: ["CACHEDIR.TAG"], regen: () => "pytest" },
      { name: ".mypy_cache", kind: "cache", strength: "strong", markers: ["CACHEDIR.TAG"], regen: () => "mypy" },
      { name: ".ruff_cache", kind: "cache", strength: "strong", markers: ["CACHEDIR.TAG"], regen: () => "ruff" },
      { name: "build", kind: "build", strength: "tool", when: hasFile("setup.py", "pyproject.toml"), markers: ["lib", "bdist.win-amd64", "bdist.linux-x86_64"], regen: () => "python -m build" },
      { name: "dist", kind: "build", strength: "tool", when: hasFile("setup.py", "pyproject.toml"), regen: () => "python -m build" },
      { name: "__pycache__", kind: "cache", strength: "strong", scattered: true, regen: () => "recreated on the next import" },
    ],
  },
  {
    id: "dotnet",
    label: ".NET",
    manifestPatterns: [/\.csproj$/i, /\.fsproj$/i, /\.vbproj$/i],
    artifacts: [
      { name: "obj", kind: "build", strength: "strong", markers: ["project.assets.json", "Debug", "Release"], regen: () => "dotnet restore" },
      { name: "bin", kind: "build", strength: "strong", markers: ["Debug", "Release"], required: true, regen: () => "dotnet build" },
    ],
  },
  {
    id: "flutter",
    label: "Flutter / Dart",
    manifests: ["pubspec.yaml"],
    artifacts: [
      { name: ".dart_tool", kind: "cache", strength: "strong", markers: ["package_config.json"], regen: () => "flutter pub get" },
      { name: "build", kind: "build", strength: "tool", regen: () => "flutter build" },
    ],
  },
  {
    id: "composer",
    label: "PHP / Composer",
    manifests: ["composer.json"],
    artifacts: [
      { name: "vendor", kind: "deps", strength: "strong", markers: ["autoload.php"], required: true, when: hasFile("composer.lock"), regen: () => "composer install" },
    ],
  },
  {
    id: "bundler",
    label: "Ruby / Bundler",
    manifests: ["Gemfile"],
    artifacts: [{ name: "vendor", kind: "deps", strength: "tool", markers: ["bundle"], required: true, when: hasFile("Gemfile.lock"), regen: () => "bundle install" }],
  },
  {
    id: "cmake",
    label: "CMake",
    manifests: ["CMakeLists.txt"],
    artifacts: [
      { name: "build", kind: "native", strength: "strong", markers: ["CMakeCache.txt"], required: true, regen: () => "cmake --build build" },
      { prefix: "cmake-build-", kind: "native", strength: "strong", markers: ["CMakeCache.txt"], required: true, regen: () => "rebuilt by your IDE" },
      { name: "out", kind: "native", strength: "strong", markers: ["build"], required: true, regen: () => "rebuilt by Visual Studio" },
    ],
  },
  {
    id: "unity",
    label: "Unity",
    manifests: ["ProjectSettings"],
    when: hasFile("Assets"),
    artifacts: [
      { name: "Library", kind: "cache", strength: "strong", markers: ["ArtifactDB", "PackageCache", "SourceAssetDB"], required: true, regen: () => "reimported when Unity opens" },
      { name: "Temp", kind: "cache", strength: "tool", regen: () => "recreated by Unity" },
      { name: "Obj", kind: "build", strength: "tool", regen: () => "recreated by Unity" },
      { name: "Logs", kind: "cache", strength: "tool", regen: () => "recreated by Unity" },
    ],
  },
  {
    id: "godot",
    label: "Godot",
    manifests: ["project.godot"],
    artifacts: [{ name: ".godot", kind: "cache", strength: "tool", regen: () => "reimported when Godot opens" }],
  },
  {
    id: "swift",
    label: "Swift Package",
    manifests: ["Package.swift"],
    artifacts: [{ name: ".build", kind: "build", strength: "tool", regen: () => "swift build" }],
  },
  {
    id: "zig",
    label: "Zig",
    manifests: ["build.zig"],
    artifacts: [
      { name: ".zig-cache", kind: "cache", strength: "tool", regen: () => "zig build" },
      { name: "zig-cache", kind: "cache", strength: "tool", regen: () => "zig build" },
      { name: "zig-out", kind: "build", strength: "tool", regen: () => "zig build" },
    ],
  },
  {
    id: "elixir",
    label: "Elixir",
    manifests: ["mix.exs"],
    artifacts: [
      { name: "_build", kind: "build", strength: "tool", regen: () => "mix compile" },
      { name: "deps", kind: "deps", strength: "tool", when: hasFile("mix.lock"), regen: () => "mix deps.get" },
    ],
  },
  {
    id: "haskell",
    label: "Haskell",
    manifests: ["stack.yaml"],
    artifacts: [{ name: ".stack-work", kind: "build", strength: "tool", regen: () => "stack build" }],
  },
];

/**
 * Names that look like cleanup targets on their own. Found with no owning
 * project, they are listed as *unclaimed* -- shown, sized, and never
 * selectable -- so a sweep that walked past 3 GB of somebody's `build` says
 * so rather than staying silent about it.
 */
export const SUSPECT_NAMES = new Set([
  "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".parcel-cache",
  ".gradle", ".cxx", "pods", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  "obj", ".dart_tool", ".svelte-kit", ".angular", ".expo", "cmake-build-debug", "cmake-build-release",
]);

/**
 * For an unclaimed folder: the strong markers any stack would accept for that
 * name. A `.venv` holding `pyvenv.cfg` is a virtual environment whoever made
 * it; it just has no requirements file beside it to rebuild it from. That is
 * worth a look (review), not a silent block.
 */
export const ORPHAN_MARKERS = new Map();
for (const stack of STACKS) {
  for (const artifact of stack.artifacts) {
    if (!artifact.name || artifact.strength !== "strong" || !artifact.markers?.length) continue;
    const key = artifact.name.toLowerCase();
    ORPHAN_MARKERS.set(key, [...new Set([...(ORPHAN_MARKERS.get(key) ?? []), ...artifact.markers])]);
  }
}

/**
 * Runtime data: things an app wrote while running. Proposed only inside a
 * detected project, only when git ignores them, and only past a size floor --
 * and never pre-selected, because unlike a build these do not come back.
 */
export const RUNTIME_NAMES = new Set([
  "uploads", "upload", "storage", "tmp", "temp", "logs", "log", "data", "media", "output", "outputs",
  "recordings", "screenshots", "videos", "renders", "exports", "hls",
]);

/** Package manager, from the lockfile that is actually there. */
function packageManagerOf(files) {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
  return "npm";
}

/** `./dist/` -> `dist`. Only a single relative segment counts. */
function cleanOutDir(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

/**
 * Build the facts stack detection needs about one directory.
 *
 * `names` are the entries of the directory; `read(name)` returns a parsed
 * JSON manifest or null. Only `package.json` and `tsconfig.json` are ever
 * read -- everything else is decided from which files exist.
 */
export async function describeProject(dir, names, read) {
  const files = new Set(names.map((name) => name.toLowerCase()));
  const pkg = files.has("package.json") ? await read("package.json") : null;
  const deps = new Set();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg?.[field] ?? {})) deps.add(name);
  }
  const tsconfig = files.has("tsconfig.json") ? await read("tsconfig.json") : null;
  return {
    dir,
    names,
    files,
    pkg,
    deps,
    packageManager: packageManagerOf(files),
    tsOutDir: cleanOutDir(tsconfig?.compilerOptions?.outDir),
  };
}

/** Which stacks this directory is the root of. */
export function detectStacks(project) {
  const found = [];
  for (const stack of STACKS) {
    const byName = stack.manifests?.some((name) => project.files.has(name.toLowerCase()));
    const byPattern = stack.manifestPatterns?.some((pattern) => project.names.some((name) => pattern.test(name)));
    if (!byName && !byPattern) continue;
    if (stack.when && !stack.when(project)) continue;
    found.push(stack);
  }
  return found;
}

function artifactMatches(artifact, name) {
  if (artifact.name) return artifact.name.toLowerCase() === name.toLowerCase();
  if (artifact.prefix) return name.toLowerCase().startsWith(artifact.prefix);
  return false;
}

/**
 * Does a stack of this project own a child directory called `name`?
 *
 * Returns the first claim whose `when` holds. Several stacks may share a
 * name -- `build` is Gradle's in an Android module and CRA's in a web app --
 * and the project's own facts decide which one is speaking.
 */
export function claimFor(project, stacks, name) {
  for (const stack of stacks) {
    for (const artifact of stack.artifacts) {
      if (artifact.scattered) continue;
      if (!artifactMatches(artifact, name)) continue;
      if (artifact.when && !artifact.when(project)) continue;
      return { stack, artifact };
    }
  }
  return null;
}

/** A scattered artifact (`__pycache__`) owned by any stack in the chain. */
export function scatteredClaimFor(stacks, name) {
  for (const stack of stacks) {
    for (const artifact of stack.artifacts) {
      if (artifact.scattered && artifactMatches(artifact, name)) return { stack, artifact };
    }
  }
  return null;
}

/** Every artifact name any stack knows, for the self-check and the window. */
export function describeStacks() {
  return STACKS.map((stack) => ({
    id: stack.id,
    label: stack.label,
    manifests: stack.manifests ?? stack.manifestPatterns?.map(String) ?? [],
    artifacts: stack.artifacts.map((artifact) => artifact.name ?? `${artifact.prefix}*`),
  }));
}
