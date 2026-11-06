// A hash of the code a build step runs: its entry modules and every module of the repo they import,
// directly or not. Steps that keep their output while their inputs are unchanged (build-movements,
// validate-plan) include it, so editing that code rebuilds the output with no format number to
// remember to bump. Comments count too: an edit anywhere in those modules rebuilds. npm packages
// aren't followed.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, ROOT } from "@transitopia/data/paths.ts";

/** `from "…"`, `import "…"` and `import("…")`. */
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

/** The repo file a specifier names, or undefined for an npm package or a built-in. */
function resolveSpecifier(spec: string, from: string): string | undefined {
  if (spec.startsWith(".")) return resolve(dirname(from), spec);
  if (!spec.startsWith("@transitopia/")) return undefined;
  // Workspaces are linked into node_modules: their real path is in the repo. A specifier in a
  // comment or string may name no file (resolve doesn't check).
  const link = fileURLToPath(import.meta.resolve(spec));
  if (!existsSync(link)) return undefined;
  const path = realpathSync(link);
  return path.includes("/node_modules/") ? undefined : path;
}

/** Hash of `entries` (absolute paths) and the repo modules they import. */
export async function sourceHash(entries: string[]): Promise<string> {
  const seen = new Map<string, string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    // A specifier in a comment or string that names no file.
    if (!(await exists(file))) continue;
    const text = await readFile(file, "utf8");
    seen.set(file, text);
    if (!file.endsWith(".ts")) continue;
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      const dep = resolveSpecifier(spec!, file);
      if (dep && !seen.has(dep)) queue.push(dep);
    }
  }
  const h = createHash("sha256");
  for (const file of [...seen.keys()].sort())
    h.update(`${relative(ROOT, file)}\n${seen.get(file)}\n`);
  return h.digest("hex").slice(0, 16);
}
