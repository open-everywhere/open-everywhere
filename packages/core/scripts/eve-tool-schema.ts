import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The one OE reader of eve's tool-schema internals. eve 1.x has no public entry for these helpers
// (`eve/tools` exports only the define* helpers), so the read stays deep. eve-tool-schema-strip-test
// (the describe_image stale-call test), eve-framework-tools-test, nullable-optional-fields-test,
// work-forward-test, work-task-key-test and worker-continuation-test read the helpers through this
// module, so a moved file fails here with a re-derive message. Other tests still import eve's schema
// module directly.

export const SCHEMA_PATH = "dist/src/tools/schema.js";

export const RESOLVE_TOOL_PATH = "dist/src/runtime/resolve-tool.js";

export interface EveSchemaHelpers {
  isToolSchema(schema: unknown): boolean;
  toInputSchema(schema: unknown): unknown;
  serializeInputSchema(schema: unknown): unknown;
}

export function installedEveRoot(resolveFrom: string = import.meta.url): string {
  return dirname(createRequire(resolveFrom).resolve("eve/package.json"));
}

export async function readEveSchemaHelpers(eveRoot: string = installedEveRoot()): Promise<EveSchemaHelpers> {
  const helperPath = join(eveRoot, SCHEMA_PATH);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(helperPath).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `eve's tool-schema helpers are no longer at ${helperPath} (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Re-read ${RESOLVE_TOOL_PATH}, find where the input schema is resolved now, and update SCHEMA_PATH. Do NOT ` +
        `delete the gate: describe_image's stale-call acceptance rides that seam.`,
      { cause },
    );
  }
  for (const name of ["isToolSchema", "toInputSchema", "serializeInputSchema"] as const) {
    if (typeof mod[name] !== "function") {
      throw new Error(`eve's ${SCHEMA_PATH} no longer exports \`${name}\`. The resolve-tool fork changed shape; re-derive it.`);
    }
  }
  return mod as unknown as EveSchemaHelpers;
}

// eve resolves a tool's input schema on two routes. A tool with an execute function takes a two-arm
// fork: the authored schema object when it is already a tool schema, else a conversion of the
// declared (serialised) one. A tool with no execute function takes the conversion alone. OE's
// stale-call tests drive the authored arm and the conversion arm, so they cover both routes. A THIRD
// route (a new conversion, a second fork site) would escape both arms, so this read refuses any shape
// but exactly one fork plus exactly one bare conversion.
const INPUT_FORK = /isToolSchema\((\w+)\.inputSchema\)\?\1\.inputSchema:toInputSchema\((\w+)\.inputSchema\)/gu;
const BARE_CONVERSION = /(?<=[{,])inputSchema:toInputSchema\((\w+)\.inputSchema\)/gu;

export interface ResolveToolInputFork {
  readonly fork: string;
  readonly conversion: string;
}

export function readResolveToolInputFork(eveRoot: string = installedEveRoot()): ResolveToolInputFork {
  const file = join(eveRoot, RESOLVE_TOOL_PATH);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(
      `eve resolve-tool: cannot read ${RESOLVE_TOOL_PATH} from the installed eve (${String(cause)}). It is where eve ` +
        `picks the input schema a tool call is validated against. Find the module's new home and update RESOLVE_TOOL_PATH.`,
      { cause },
    );
  }
  const forks = [...source.matchAll(INPUT_FORK)].map((m) => m[0]);
  const bare = [...source.matchAll(BARE_CONVERSION)].map((m) => m[0]);
  const conversions = source.split("toInputSchema(").length - 1;
  if (forks.length !== 1 || bare.length !== 1 || conversions !== 2) {
    throw new Error(
      `eve resolve-tool: ${RESOLVE_TOOL_PATH} holds ${forks.length} two-arm input-schema fork(s), ${bare.length} bare ` +
        `conversion(s) and ${conversions} \`toInputSchema(\` call(s); this read expects 1, 1 and 2. eve changed how it ` +
        `resolves a tool's input schema, so the two arms OE's stale-call tests drive may no longer be the only routes. ` +
        `Re-read the module and re-derive the arms before you change these counts.`,
    );
  }
  return { fork: forks[0]!, conversion: bare[0]! };
}
