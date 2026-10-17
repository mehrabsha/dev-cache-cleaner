/**
 * Evidence in, one of three answers out.
 *
 *   safe     a detected stack owns it, nothing in it is committed, and either
 *            git ignores it or a marker only a tool writes is inside
 *   review   probably regenerable but the evidence is thinner -- or runtime
 *            data, which is not regenerable at all and is only ever deleted by
 *            a person who looked
 *   blocked  committed files inside, no project claims it, or it does not
 *            look like what its name says. Shown, never selectable.
 *
 * The rules run from the most conservative down and stop at the first that
 * applies, so adding a rule can only move a verdict *toward* blocked. The
 * self-check asserts that: every combination of evidence is run, and no
 * combination with committed files or without an owner comes out selectable.
 *
 * Pure: no filesystem, no git. Everything it needs arrives on `candidate`.
 */

export const TIERS = ["safe", "review", "blocked"];

/** `{ ok: true|false|null, text }` -- null is neutral, a fact rather than a point. */
const fact = (ok, text) => ({ ok, text });

export function judge(candidate) {
  const evidence = [];
  const { claim, runtime, marker, git } = candidate;
  const artifact = claim?.artifact;
  const markers = artifact?.markers ?? [];

  // ── ownership ────────────────────────────────────────────────────────────
  if (claim) {
    const where = candidate.scattered ? "inside" : "beside";
    evidence.push(fact(true, `A ${claim.stack.label} project (${candidate.manifest ?? "manifest"}) sits ${where} it and owns “${candidate.name}”.`));
  } else if (runtime) {
    evidence.push(fact(null, `Inside the project “${candidate.projectName}”, named like data an app writes while running.`));
  } else {
    evidence.push(fact(false, "No project here declares it — no manifest beside it uses a tool that writes this folder."));
    if (marker) evidence.push(fact(null, `But it contains ${marker}, which only a tool writes.`));
  }

  // ── markers ──────────────────────────────────────────────────────────────
  if (markers.length) {
    if (marker) evidence.push(fact(true, `Contains ${marker}, which a tool writes and a person does not.`));
    else evidence.push(fact(false, `None of the files a generated “${candidate.name}” normally has (${markers.slice(0, 4).join(", ")}).`));
  }

  // ── git ──────────────────────────────────────────────────────────────────
  if (git.state === "unavailable") {
    evidence.push(fact(null, "git is not installed, so committed files could not be checked."));
  } else if (git.state === "error") {
    evidence.push(fact(null, "git could not answer for this repository."));
  } else if (git.state === "none") {
    evidence.push(fact(null, "Not inside a git repository."));
  } else {
    if (git.tracked > 0) evidence.push(fact(false, `${git.tracked.toLocaleString()} committed file${git.tracked === 1 ? "" : "s"} inside — this is source, whatever its name.`));
    else if (git.tracked === 0) evidence.push(fact(true, "No committed files inside."));
    if (git.ignore?.ignored) {
      const where = git.ignore.source ? `${git.ignore.source}${git.ignore.line ? `:${git.ignore.line}` : ""}` : ".gitignore";
      evidence.push(fact(true, `Ignored by git — ${where} (${git.ignore.pattern}).`));
    } else if (git.ignore) {
      evidence.push(fact(false, "Not listed in .gitignore."));
    }
  }

  const verdict = (tier, reason) => ({ tier, reason, evidence });
  const inRepo = git.state === "ok";

  // ── rules, most conservative first ───────────────────────────────────────
  if (inRepo && git.tracked > 0) {
    return verdict("blocked", `${git.tracked.toLocaleString()} committed file${git.tracked === 1 ? "" : "s"} inside — not a generated folder.`);
  }
  if (inRepo && git.tracked == null) {
    return verdict("blocked", "Committed files could not be ruled out.");
  }
  if (!claim && !runtime) {
    // An orphan that carries a tool's marker: generated, but nothing here can
    // rebuild it. A person may still want it gone -- never pre-selected.
    if (marker) return verdict("review", `Looks generated (${marker} inside), but no project beside it can rebuild it.`);
    return verdict("blocked", "No project here owns it.");
  }
  if (artifact?.required && !marker) {
    return verdict("blocked", `Does not look like a generated “${candidate.name}”.`);
  }

  if (runtime) {
    return verdict("review", "Runtime data — not regenerable. Look inside before deleting.");
  }

  const strongMarker = Boolean(marker) && artifact.strength === "strong";
  const markerMissing = markers.length > 0 && !marker;

  if (inRepo) {
    if (git.ignore?.ignored && !markerMissing) {
      return verdict("safe", `${claim.stack.label} writes it, git ignores it, and nothing in it is committed.`);
    }
    if (git.ignore?.ignored) {
      return verdict("review", "Ignored by git, but missing the files a generated one has.");
    }
    // Not ignored, but nothing committed and a marker only a tool writes: the
    // repository simply never mentions it (a home folder that is a repo, a
    // project nested in someone else's). The marker settles it.
    if (strongMarker) {
      return verdict("safe", `${claim.stack.label} writes it, ${marker} inside proves it, and nothing in it is committed.`);
    }
    return verdict("review", "Not in .gitignore — check it is not something you meant to keep.");
  }

  if (strongMarker) {
    return verdict("safe", `${claim.stack.label} writes it, and ${marker} inside proves it was generated.`);
  }
  return verdict("review", git.state === "none"
    ? "Not in a git repository, so only the project's tooling says it is output."
    : "git could not confirm it, so only the project's tooling says it is output.");
}
