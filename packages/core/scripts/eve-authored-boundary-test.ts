import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const CARRIER = join(eveRoot, "dist", "src", "internal", "authored-package-boundary.js");

interface ResolveResult {
  readonly external?: boolean;
  readonly id?: string;
}
interface ResolveCtx {
  resolve(source: string, importer: string | undefined, opts: unknown): Promise<{ id: string } | null>;
}
interface BoundaryPlugin {
  resolveId(this: ResolveCtx, source: string, importer: string | undefined, opts: { kind: string }): Promise<ResolveResult | undefined>;
}
type PluginFactory = (opts: { packageRoot: string; externalDependencies: readonly string[] }) => BoundaryPlugin;

// hosted-inline-exempt: a deliberate reach into eve's installed internals by absolute path; eve's
const boundary = (await import(pathToFileURL(CARRIER).href)) as {
  createRuntimeLoaderPackageBoundaryPlugin: PluginFactory;
  createGenerationPackageBoundaryPlugin: PluginFactory;
};

const app = realpathSync(mkdtempSync(join(tmpdir(), "oe-eve-boundary-")));
const write = (rel: string, body: string): string => {
  const file = join(app, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
};
const link = (rel: string, target: string): void => {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  symlinkSync(target, join(app, rel), "dir");
};

write("package.json", JSON.stringify({ name: "fixture-app", private: true }));
const importer = write("agent/channels/a.ts", 'import "@fx/built";\n');

const builtEntry = write("packages/built/index.js", "export const x = 1;\n");
write("packages/built/package.json", JSON.stringify({ name: "@fx/built", main: "index.js" }));
link("node_modules/@fx/built", "../../packages/built");

const tsEntry = write("packages/ts/index.ts", "export const x: number = 1;\n");
write("packages/ts/package.json", JSON.stringify({ name: "@fx/ts", main: "index.ts" }));
link("node_modules/@fx/ts", "../../packages/ts");

const shadowEntry = write("packages/shadow-real/index.js", "export const x = 1;\n");
write("packages/shadow-real/package.json", JSON.stringify({ name: "@fx/shadow", main: "index.js" }));
write("packages/shadow-other/index.js", "export const x = 2;\n");
write("packages/shadow-other/package.json", JSON.stringify({ name: "@fx/shadow", main: "index.js" }));
link("node_modules/@fx/shadow", "../../packages/shadow-other");

const plainEntry = write("node_modules/plain/index.js", "export const x = 1;\n");
write("node_modules/plain/package.json", JSON.stringify({ name: "plain", main: "index.js" }));

const RESOLVED: Record<string, string> = {
  "@fx/built": builtEntry,
  "@fx/ts": tsEntry,
  "@fx/shadow": shadowEntry,
  plain: plainEntry,
};
const ctx: ResolveCtx = {
  async resolve(source) {
    const id = RESOLVED[source];
    return id === undefined ? null : { id };
  },
};
const opts = { packageRoot: app, externalDependencies: [] as readonly string[] };
const KIND = { kind: "import-statement" };

const runtime = boundary.createRuntimeLoaderPackageBoundaryPlugin(opts);
const generation = boundary.createGenerationPackageBoundaryPlugin(opts);
const evaluate = (source: string): Promise<ResolveResult | undefined> => runtime.resolveId.call(ctx, source, importer, KIND);
const generate = (source: string): Promise<ResolveResult | undefined> => generation.resolveId.call(ctx, source, importer, KIND);

const built = await evaluate("@fx/built");
ok(
  built?.external === true && built.id === "@fx/built",
  `built: the evaluation path keeps a symlinked workspace package with a JavaScript entry EXTERNAL, by its bare ` +
    `specifier (got ${JSON.stringify(built)}). An inlined result means part 10 is absent from ${CARRIER}. On eve ` +
    `1.0.0-rc.18 the authored graph then inlines the @open-everywhere packages, and \`eve build\` exits 13 (Node's ` +
    `unsettled top-level await) before it writes a build (OPE-2705). On eve 0.54.3 the same absence cost 31 graph ` +
    `evaluations per cold build (OPE-2276)`,
);

const ts = await evaluate("@fx/ts");
ok(
  ts?.external !== true,
  `ts: a symlinked workspace package with a TypeScript entry stays INLINED on the evaluation path (got ` +
    `${JSON.stringify(ts)}). Node cannot load a .ts entry, so eve must keep compiling it — this is the case eve's ` +
    `inlining exists for, and part 10 must never take it`,
);

const shadow = await evaluate("@fx/shadow");
ok(
  shadow?.external !== true,
  `shadow: a package whose node_modules entry links to a DIFFERENT directory than the one the resolver reached ` +
    `stays INLINED (got ${JSON.stringify(shadow)}). Externalising it would make Node load another file at run time`,
);

const plain = await evaluate("plain");
ok(
  plain?.external === true && plain.id === "plain",
  `plain: an ordinary installed package stays EXTERNAL by eve's own /node_modules/ route (got ${JSON.stringify(plain)})`,
);

const generated = await generate("@fx/built");
ok(
  generated?.external !== true,
  `generation: the GENERATION plugin still inlines the built workspace package (got ${JSON.stringify(generated)}). ` +
    `That path is where eve's dynamic-tool transform stamps inline callbacks, so externalising the package there ` +
    `drops the stamps — the reason build.externalDependencies cannot land (OPE-2270)`,
);

console.log(
  `\n✓ eve-authored-boundary: ${n} assertions passed (part 10 externalises a built workspace package on the ` +
    `evaluation path only; TypeScript and shadowed packages stay inlined; the generation path is unchanged)\n`,
);
