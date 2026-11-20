import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The one door to eve's internal `dist/src` files.
 *
 * eve's stability promise covers its `exports` map only. A few build and integration-tier paths read
 * files behind that map on purpose, because no public entry gives the same thing. Each such read goes
 * through one module in this folder, one module per eve file. Each module names its file and its
 * exports, and `scripts/eve-deep-reads-test.ts` loads every one of them against the installed eve. A
 * read that an eve bump moves then fails that test by file and export name, not as a slow fallback or
 * an `undefined is not a function` deep in a run.
 */

/** The path of eve's compiled source under an app root. Every deep read resolves from here. */
export const EVE_DIST_SRC: readonly string[] = ["node_modules", "eve", "dist", "src"];

/** A deep read that no longer finds its file or its export on the installed eve. */
export class EveDeepReadError extends Error {
  readonly file: string;
  readonly missing: string;
  readonly owner: string;

  constructor(input: { readonly file: string; readonly missing: string; readonly owner: string }) {
    super(
      `eve deep read broken: eve/dist/src/${input.file} — ${input.missing}. eve's stability promise covers its ` +
        "exports map only, and this read is deliberate. An eve bump moved it. Check whether a public entry now " +
        `gives the same thing. If not, find the new home under node_modules/eve/dist and update ${input.owner}.`,
    );
    this.name = "EveDeepReadError";
    this.file = input.file;
    this.missing = input.missing;
    this.owner = input.owner;
  }
}

/** The absolute path of one eve internal file under an app root. */
export function eveInternalPath(root: string, file: string): string {
  return join(root, ...EVE_DIST_SRC, file);
}

/**
 * Imports one eve internal file and returns the named function exports. It throws
 * {@link EveDeepReadError} when the file is gone or an export is not a function.
 */
export async function loadEveInternalFunctions<const N extends string>(input: {
  readonly root: string;
  readonly file: string;
  readonly names: readonly N[];
  readonly owner: string;
}): Promise<Record<N, (...args: never[]) => unknown>> {
  const path = eveInternalPath(input.root, input.file);
  if (!existsSync(path)) throw new EveDeepReadError({ file: input.file, missing: "the whole module is gone", owner: input.owner });
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const out = {} as Record<N, (...args: never[]) => unknown>;
  for (const name of input.names) {
    const value = mod[name];
    if (typeof value !== "function") {
      throw new EveDeepReadError({ file: input.file, missing: `it no longer exports the function ${name}`, owner: input.owner });
    }
    out[name] = value as (...args: never[]) => unknown;
  }
  return out;
}

/** Reads one eve internal file as text. It throws {@link EveDeepReadError} when the file is gone. */
export function readEveInternalSource(input: { readonly root: string; readonly file: string; readonly owner: string }): string {
  const path = eveInternalPath(input.root, input.file);
  if (!existsSync(path)) throw new EveDeepReadError({ file: input.file, missing: "the whole module is gone", owner: input.owner });
  return readFileSync(path, "utf8");
}

/**
 * Imports one eve internal file and returns the named exports of any kind (a context key is an object,
 * not a function). It throws {@link EveDeepReadError} when the file is gone or an export is absent.
 */
export async function loadEveInternalExports<const N extends string>(input: {
  readonly root: string;
  readonly file: string;
  readonly names: readonly N[];
  readonly owner: string;
}): Promise<Record<N, unknown>> {
  const path = eveInternalPath(input.root, input.file);
  if (!existsSync(path)) throw new EveDeepReadError({ file: input.file, missing: "the whole module is gone", owner: input.owner });
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const out = {} as Record<N, unknown>;
  for (const name of input.names) {
    if (mod[name] === undefined) {
      throw new EveDeepReadError({ file: input.file, missing: `it no longer exports ${name}`, owner: input.owner });
    }
    out[name] = mod[name];
  }
  return out;
}
