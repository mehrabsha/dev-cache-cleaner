/**
 * Reading a project's manifest. The only file read in this project that looks
 * at contents rather than names and sizes.
 *
 * Two files are ever read -- `package.json` and `tsconfig.json` -- because they
 * are the two whose contents change what a folder is: a `dist` beside a
 * package.json that depends on Vite is Vite's, and an `outDir` in tsconfig
 * names the folder tsc writes. Everything else is decided by which files exist.
 *
 * Capped and forgiving: a manifest over 1 MB, or one that does not parse, is
 * treated as absent. tsconfig allows comments and trailing commas, so those are
 * stripped before parsing rather than calling the file broken.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_MANIFEST_BYTES = 1024 * 1024;

/** JSON with comments, as tsconfig writes it. Strings are left alone. */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** A parsed manifest from `dir`, or null. Never throws. */
export async function readManifest(dir, name) {
  try {
    const buffer = await readFile(join(dir, name));
    if (buffer.length > MAX_MANIFEST_BYTES) return null;
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    try {
      return JSON.parse(text);
    } catch {
      return JSON.parse(stripJsonComments(text));
    }
  } catch {
    return null;
  }
}
