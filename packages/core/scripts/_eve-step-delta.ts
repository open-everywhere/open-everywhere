import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type SavedEveContext = Record<string, unknown>;

interface EveInternals {
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
  serializeContext(ctx: unknown): SavedEveContext;
  deserializeContext(saved: SavedEveContext): Promise<unknown>;
  snapshotValue(v: unknown): unknown;
  diffValue(base: unknown, next: unknown): unknown;
  applyValueDelta(base: unknown, delta: unknown): unknown;
}

let internals: Promise<EveInternals> | undefined;

function loadEveInternals(): Promise<EveInternals> {
  internals ??= (async () => {
    const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
    const load = (rel: string) => import(pathToFileURL(join(eveRoot, "dist/src", rel)).href);
    const [container, serialize, delta] = await Promise.all([
      load("context/container.js"),
      load("context/serialize.js"),
      load("shared/value-delta.js"),
    ]);
    return { ...container, ...serialize, ...delta } as EveInternals;
  })();
  return internals;
}

export async function runEveStep<T>(saved: SavedEveContext, fn: () => T): Promise<{ result: T; saved: SavedEveContext }> {
  const eve = await loadEveInternals();
  const input = structuredClone(saved);
  const base = eve.snapshotValue(input);
  const ctx = await eve.deserializeContext(input);
  const result = eve.contextStorage.run(ctx, fn);
  const delta = eve.diffValue(base, eve.serializeContext(ctx));
  const next = eve.applyValueDelta(structuredClone(saved), delta) as SavedEveContext;
  return { result, saved: structuredClone(next) };
}
