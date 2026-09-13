import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { asSchema } from "ai";
import { toJSONSchema } from "zod/v4/core";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

interface EveSchemaHelpers {
  toInputSchema: (schema: unknown) => unknown;
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const helperPath = join(eveRoot, "dist/src/tools/schema.js");

let eve: EveSchemaHelpers;
try {
  eve = (await import(pathToFileURL(helperPath).href)) as unknown as EveSchemaHelpers;
} catch (error) {
  throw new Error(
    `zod-seam: could not import eve's schema helpers from ${helperPath} — ${(error as Error).message}. ` +
      "If eve moved the module, re-derive which zod instance rehydrates an MCP inputSchema before editing this gate (OPE-1751).",
  );
}
ok(typeof eve.toInputSchema === "function", "setup: eve still exports `toInputSchema` — the rehydration seam this gate crosses");

const ALL_OF_SCHEMA = {
  type: "object",
  properties: {
    rich_text: {
      type: "array",
      items: {
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "string" } } },
        ],
      },
    },
  },
} as const;

const PLAIN_SCHEMA = {
  type: "object",
  properties: {
    rich_text: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
  },
} as const;

const itemProperties = (emitted: unknown): string[] => {
  const doc = emitted as { properties?: { rich_text?: { items?: { properties?: Record<string, unknown> } } } };
  return Object.keys(doc.properties?.rich_text?.items?.properties ?? {}).sort();
};

const rehydrated = eve.toInputSchema(ALL_OF_SCHEMA);
let coreEmitted: unknown;
let coreError: Error | undefined;
try {
  coreEmitted = toJSONSchema(rehydrated as never, { target: "draft-7", io: "input" });
} catch (error) {
  coreError = error as Error;
}
ok(
  coreError === undefined,
  `core: the ROOT zod's toJSONSchema converts a schema eve rehydrated with its VENDORED zod — got "${coreError?.message ?? ""}". ` +
    "This is the OPE-1751 crash: two zod instances split one traversal (the caller builds the context, the schema owns the " +
    "processors), so a version skew makes an intersection processor read a context field its caller never created. " +
    "Run `npm ls zod`: the tree must show ONE version, equal to the zod eve vendors under " +
    "node_modules/eve/dist/src/node_modules/.pnpm/zod@<ver>.",
);

let sdkEmitted: unknown;
let sdkError: Error | undefined;
try {
  sdkEmitted = (asSchema as (value: unknown) => { jsonSchema: unknown })(rehydrated).jsonSchema;
} catch (error) {
  sdkError = error as Error;
}
ok(
  sdkError === undefined,
  `sdk: asSchema() from \`ai\` converts the same rehydrated schema — got "${sdkError?.message ?? ""}". ` +
    "This is the call the AI SDK makes for EVERY tool on EVERY model call, so a red here means every session that mounts " +
    "this tool fails its turn as MODEL_CALL_FAILED (OPE-1751).",
);

ok(
  itemProperties(coreEmitted).join(",") === "a,b",
  `merged: the emitted items carry BOTH allOf branches (got ${JSON.stringify(itemProperties(coreEmitted))}) — ` +
    "without this the two cases above would pass on a zod that silently dropped the intersection node, and this gate would assert nothing",
);
ok(
  itemProperties(sdkEmitted).join(",") === "a,b",
  `merged: asSchema()'s document carries both branches too (got ${JSON.stringify(itemProperties(sdkEmitted))})`,
);

const plainEmitted = toJSONSchema(eve.toInputSchema(PLAIN_SCHEMA) as never, { target: "draft-7", io: "input" });
ok(
  itemProperties(plainEmitted).join(",") === "a",
  `control: the same shape with NO allOf emits items with one property (got ${JSON.stringify(itemProperties(plainEmitted))}) — ` +
    "proving the `merged:` cases observe the intersection and not a property every object schema has",
);

console.log(
  `✓ zod-seam: ${n} assertions passed (eve's vendored-zod rehydration of an allOf survives conversion by the root zod, through zod/v4/core and through asSchema() from \`ai\`, with both branches merged and a no-allOf control)`,
);
