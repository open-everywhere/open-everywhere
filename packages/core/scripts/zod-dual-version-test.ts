import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { asSchema } from "ai";
import { z } from "zod";
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

interface StandardShape {
  readonly "~standard"?: {
    readonly vendor?: string;
    readonly validate?: (value: unknown) => { readonly issues?: readonly unknown[] } | Promise<{ readonly issues?: readonly unknown[] }>;
  };
}

const itemProperties = (emitted: unknown): string[] => {
  const doc = emitted as { properties?: { rich_text?: { items?: { properties?: Record<string, unknown> } } } };
  return Object.keys(doc.properties?.rich_text?.items?.properties ?? {}).sort();
};

const allOfBranchProperties = (emitted: unknown): string[] => {
  const doc = emitted as { properties?: { rich_text?: { items?: { allOf?: { properties?: Record<string, unknown> }[] } } } };
  return (doc.properties?.rich_text?.items?.allOf ?? []).map((b) => Object.keys(b.properties ?? {}).sort().join("+"));
};

const rehydrated = eve.toInputSchema(ALL_OF_SCHEMA) as StandardShape & Record<string, unknown>;
ok(
  rehydrated["~standard"]?.vendor === "eve" && !("_zod" in rehydrated),
  `no-zod: eve's toInputSchema wraps a JSON Schema in its OWN standard schema, not a zod one (vendor ${JSON.stringify(rehydrated["~standard"]?.vendor)}, _zod ${String("_zod" in rehydrated)}). ` +
    "If this reds, eve rehydrates tool schemas with a zod again — the OPE-1751 crossing is back, and the root zod must equal eve's vendored zod. Re-derive before relaxing anything.",
);

const validate = rehydrated["~standard"]?.validate;
ok(typeof validate === "function", "live: eve's standard schema carries a validator");
const accepted = await validate!({ rich_text: [{ a: "x", b: "y" }] });
const refused = await validate!({ rich_text: [{ a: 1 }] });
ok((accepted.issues ?? []).length === 0, `live: a value that satisfies both allOf branches validates (issues: ${JSON.stringify(accepted.issues)})`);
ok((refused.issues ?? []).length > 0, "live: a value of the wrong type is REFUSED — the validator is real, not a pass-through stub");

let sdkEmitted: unknown;
let sdkError: Error | undefined;
try {
  sdkEmitted = (asSchema as (value: unknown) => { jsonSchema: unknown })(rehydrated).jsonSchema;
} catch (error) {
  sdkError = error as Error;
}
ok(
  sdkError === undefined,
  `sdk: asSchema() from \`ai\` converts the schema eve built — got "${sdkError?.message ?? ""}". ` +
    "This is the call the AI SDK makes for EVERY tool on EVERY model call, so a red here means every session that mounts " +
    "this tool fails its turn as MODEL_CALL_FAILED (OPE-1751).",
);
ok(
  allOfBranchProperties(sdkEmitted).join(",") === "a,b",
  `sdk: the model document carries the allOf with BOTH branches (got ${JSON.stringify(allOfBranchProperties(sdkEmitted))})`,
);

const rootSchema = z.object({ rich_text: z.array(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))) });
ok(eve.toInputSchema(rootSchema) === rootSchema, "root: eve passes a root-zod schema through toInputSchema UNCHANGED — no second instance touches it");
let rootEmitted: unknown;
let rootError: Error | undefined;
try {
  rootEmitted = (asSchema as (value: unknown) => { jsonSchema: unknown })(eve.toInputSchema(rootSchema)).jsonSchema;
} catch (error) {
  rootError = error as Error;
}
ok(rootError === undefined, `root: asSchema() converts the root-zod intersection — got "${rootError?.message ?? ""}"`);
ok(
  itemProperties(rootEmitted).join(",") === "a,b",
  `root: the emitted items carry BOTH intersection branches (got ${JSON.stringify(itemProperties(rootEmitted))}) — ` +
    "the intersection processor ran. Without this the case above would pass on a zod that silently dropped the node",
);
ok(
  itemProperties(toJSONSchema(rootSchema as never, { target: "draft-7", io: "input" })).join(",") === "a,b",
  "root: the root zod's own toJSONSchema merges the same intersection",
);

const plainEmitted = (asSchema as (value: unknown) => { jsonSchema: unknown })(eve.toInputSchema(z.object({ rich_text: z.array(z.object({ a: z.string() })) }))).jsonSchema;
ok(
  itemProperties(plainEmitted).join(",") === "a",
  `control: the same shape with NO intersection emits items with one property (got ${JSON.stringify(itemProperties(plainEmitted))}) — ` +
    "proving the `root:` cases observe the intersection and not a property every object schema has",
);

console.log(
  `✓ zod-seam: ${n} assertions passed (eve 0.71 wraps a JSON-Schema tool schema in its own validating standard schema — no vendored zod on the tool path; asSchema() from \`ai\` carries an allOf whole; a root-zod intersection crosses eve's helper unchanged and merges both branches, with a no-intersection control)`,
);
