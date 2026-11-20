import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-eve-schema-strip-")), "ops.sqlite3");

import describeImage from "../agent/tools/describe_image.js";
import { installedEveRoot, readEveSchemaHelpers, readResolveToolInputFork, RESOLVE_TOOL_PATH } from "./eve-tool-schema.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const eveRoot = installedEveRoot();
const eve = await readEveSchemaHelpers(eveRoot);

{
  const { fork, conversion } = readResolveToolInputFork(eveRoot);
  ok(
    /^isToolSchema\(\w+\.inputSchema\)\?\w+\.inputSchema:toInputSchema\(\w+\.inputSchema\)$/u.test(fork),
    `🔴 anchor: eve resolves an executable tool's input schema through exactly ONE two-arm fork (read: ${fork}). The live-arm and other-arm cases below drive those arms`,
  );
  ok(
    /^inputSchema:toInputSchema\(\w+\.inputSchema\)$/u.test(conversion),
    `🔴 anchor: a tool with no execute function takes the conversion alone (read: ${conversion}) — the other-arm case below drives that route too, and a third route would escape both`,
  );
  const dir = mkdtempSync(join(tmpdir(), "oe-eve-resolve-tool-"));
  const write = (body: string): string => {
    mkdirSync(join(dir, "dist/src/runtime"), { recursive: true });
    writeFileSync(join(dir, RESOLVE_TOOL_PATH), body);
    return dir;
  };
  const refuses = (body: string, label: string): void => {
    let threw = false;
    try {
      readResolveToolInputFork(write(body));
    } catch {
      threw = true;
    }
    ok(threw, label);
  };
  const forkOf = "let s=isToolSchema(a.inputSchema)?a.inputSchema:toInputSchema(e.inputSchema);";
  const bareOf = "let t={inputSchema:toInputSchema(e.inputSchema)};";
  ok(readResolveToolInputFork(write(bareOf + forkOf)).fork.startsWith("isToolSchema("), "control: the rc's shape (one bare conversion, one fork) reads clean from a fixture");
  refuses(bareOf + "let s=toInputSchema(e.inputSchema);", "🔴 a resolver with NO fork (always converts) is refused — the live-arm case would then test a route eve never takes");
  refuses(bareOf + forkOf + "let u=toInputSchema(serializeInputSchema(e.inputSchema));", "🔴 a THIRD conversion beside the two routes is refused — a third route escapes both arm cases");
  refuses(bareOf + forkOf + forkOf, "🔴 two fork sites are refused — eve then resolves input schemas in more places than the arms cover");
  refuses(forkOf, "🔴 a resolver that dropped the no-execute route is refused too — the counts are the re-derivation, in both directions");
}

type Validated = { value?: unknown; issues?: readonly unknown[] };
async function validate(schema: unknown, input: unknown): Promise<Validated> {
  const std = (schema as { "~standard"?: { validate?: (v: unknown) => Validated | Promise<Validated> } })["~standard"];
  if (typeof std?.validate !== "function") throw new Error("the resolved input schema is not a Standard Schema — eve validates tool input through `~standard.validate` (OPE-1186)");
  return await std.validate(input);
}

const resolveLikeEve = (declared: unknown): unknown => (eve.isToolSchema(declared) ? declared : eve.toInputSchema(declared));

const convertedArm = (declared: unknown): unknown => eve.toInputSchema(eve.serializeInputSchema(declared));

const declared = (describeImage as unknown as { inputSchema: unknown }).inputSchema;
const STALE_CALL = { attachmentId: "F0BQ89BMX7S", hint: "what does it show?" };

{
  const resolved = resolveLikeEve(declared);
  const out = await validate(resolved, STALE_CALL);
  ok(out.issues === undefined, "🔴 live arm: the schema eve resolves for describe_image ACCEPTS a stale call — a rejection here IS the invisible failure (no tool call, no audit row, nothing in the transcript)");
  const kept = out.value as Record<string, unknown> | undefined;
  ok(kept?.hint === "what does it show?", "live arm: the DECLARED keys survive validation untouched — whatever happens to the stale key, the call itself is not mangled");
  ok(kept !== undefined && !("attachmentId" in kept), "live arm: the undeclared key is dropped — today's mechanism, a plain zod object's strip");
}

{
  const converted = convertedArm(declared);
  ok(converted !== declared, "other arm: the round trip really produced a DIFFERENT schema — the same object would make the case below a copy of the live arm");
  const out = await validate(converted, STALE_CALL);
  ok(out.issues === undefined, "🔴 other arm: the round-tripped schema ACCEPTS the stale call too — so the property holds whichever fork `resolve-tool.js` takes");
  ok((out.value as Record<string, unknown> | undefined)?.hint === "what does it show?", "other arm: the round-tripped schema keeps the declared keys");
}

{
  const emitted = eve.serializeInputSchema(declared) as { additionalProperties?: unknown };
  ok(emitted.additionalProperties !== false, "🔴 provider: the serialised declaration does NOT forbid extra properties — `additionalProperties: false` fails a stale call inside provider validation, before eve emits actions.requested");
}

{
  const strict = z
    .object({
      kind: z.enum(["attachment", "path", "url"]).optional(),
      ref: z.string().min(1).optional(),
      mimeType: z.string().min(1).optional(),
      hint: z.string().min(1).optional(),
    })
    .strict();
  const live = await validate(resolveLikeEve(strict), STALE_CALL);
  ok(Array.isArray(live.issues) && live.issues.length > 0, "control: a `.strict()` object REJECTS the stale call through the same helpers — the live-arm acceptance case can fail");
  const round = await validate(convertedArm(strict), STALE_CALL);
  ok(Array.isArray(round.issues) && round.issues.length > 0, "control: the round trip of a `.strict()` object rejects it too — the other-arm acceptance case can fail");
  const emitted = eve.serializeInputSchema(strict) as { additionalProperties?: unknown };
  ok(emitted.additionalProperties === false, "control: `.strict()` serialises with `additionalProperties: false` — the provider case can fail too");
}

console.log(`✓ eve-tool-schema-strip: ${n} assertions passed (a stale describe_image call survives eve's resolve-tool fork on both arms, and the serialised declaration forbids no extra property — with a strict-object control on all three)`);
