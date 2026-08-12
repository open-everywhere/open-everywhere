import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { replayStepNames } from "@open-everywhere/core/agent/adapter-api.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";

delete process.env.OE_PLATFORM;
overrideSettingsForTest({ tools: { sourceScopedMount: false } });

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const linearCtx = { channel: { kind: "linear" }, session: { auth: { current: { attributes: {} } } } };
const CASES = [
  { slug: "read_linear_issue", entryKey: "_single", ctx: linearCtx },
] as const;
const SLUGS = [...new Set(CASES.map((c) => c.slug))];

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");

console.log("1. source scan (factored shape, closed inventory):");
{
  let scanned = 0;
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(toolsDir, f), "utf8");
    const dynAt = src.indexOf("defineDynamic(");
    if (dynAt === -1) continue;
    scanned++;
    const slug = f.replace(/\.ts$/, "");
    ok(
      (SLUGS as readonly string[]).includes(slug),
      `${f} uses defineDynamic but has no row in this test's inventory — pre-register its entry and add the (slug, entryKey) row here`,
    );
    ok(
      !src.slice(dynAt).includes("defineTool("),
      `${f} has an inline defineTool literal inside/after its defineDynamic call — factor it to a top-level const + preRegisterDynamicEntry`,
    );
    ok(src.includes("preRegisterDynamicEntry("), `${f} never calls preRegisterDynamicEntry — a cold-resumed session silently skips the tool`);
  }
  eq(scanned, SLUGS.length, `the scan saw exactly the ${SLUGS.length} inventoried defineDynamic tool files`);
}

console.log("2. module-load registration (no resolver run):");
const resolvers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
for (const slug of SLUGS) {
  const mod = (await import(`../agent/tools/${slug}.js`)) as { default: { events?: Record<string, (event: unknown, ctx: unknown) => unknown> } };
  const handler = mod.default.events?.["session.started"];
  ok(typeof handler === "function", `${slug} exports a defineDynamic default with a session.started resolver`);
  resolvers.set(slug, handler!);
}
const reg = (globalThis as Record<symbol, unknown>)[Symbol.for("@workflow/core//registeredSteps")] as Map<string, unknown>;
ok(reg instanceof Map, "the @workflow/core step registry exists after module load");
for (const c of CASES) {
  const names = replayStepNames(c.slug, c.entryKey);
  ok(typeof reg.get(names.execute) === "function", `${c.slug}:${c.entryKey} execute is registered at MODULE LOAD under ${names.execute}`);
  ok(reg.get(names.approval) === undefined, `${c.slug}:${c.entryKey} registers NO approval step (raw dynamic tools stay approval-less)`);
}

console.log("3. resolver returns the pre-registered (stamped) entry:");
for (const c of CASES) {
  const resolved = (await resolvers.get(c.slug)!({}, c.ctx)) as Record<string, unknown> | null;
  ok(resolved !== null && typeof resolved.execute === "function", `${c.slug}:${c.entryKey} arms on its happy-path session`);
  const names = replayStepNames(c.slug, c.entryKey);
  eq(
    (resolved!.__executeStepFn as { stepId?: string } | undefined)?.stepId,
    names.execute,
    `${c.slug}:${c.entryKey} resolver returns the STAMPED entry (durable metadata will name the module-load step)`,
  );
  ok(resolved!.__closureVars !== undefined, `${c.slug}:${c.entryKey} entry carries __closureVars (a metadata row without it is skipped on replay)`);
}

console.log(`\nlinear dynamic-replay: ${n} assertions passed.`);
