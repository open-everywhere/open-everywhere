import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-dynamic-replay-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
delete process.env.OE_GENERIC_READ_VERBS;
delete process.env.OE_SOURCE_SCOPED_TOOLS;

import { replayStepNames } from "../agent/access/window-gated.js";
import { registerBrowserToolkit } from "../agent/access/browser-toolkit.js";

registerBrowserToolkit({
  browser_navigate: { description: "fake", inputSchema: {}, execute: () => ({ ok: true }) },
  browser_screenshot: { description: "fake", inputSchema: {}, execute: () => ({ ok: true }) },
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

interface ToolCase {
  readonly slug: string;
  readonly entryKey: string;
  readonly ctx: unknown;
  readonly env?: Readonly<Record<string, string>>;
}
const slackCtx = { channel: { kind: "slack" }, session: { auth: { current: { attributes: {} } } } };
const linearCtx = { channel: { kind: "linear" }, session: { auth: { current: { attributes: {} } } } };
const unifiedCtx = { channel: { kind: "unified" }, session: { auth: { current: { attributes: { oe_platform: "slack" } } } } };
const CASES: readonly ToolCase[] = [
  { slug: "reply", entryKey: "_base", ctx: slackCtx },
  { slug: "reply", entryKey: "_single", ctx: unifiedCtx },
  { slug: "react", entryKey: "_single", ctx: slackCtx },
  { slug: "read_channel", entryKey: "_single", ctx: slackCtx, env: { OE_GENERIC_READ_VERBS: "1" } },
  { slug: "read_thread", entryKey: "_single", ctx: slackCtx, env: { OE_GENERIC_READ_VERBS: "1" } },
  { slug: "read_slack_channel", entryKey: "_single", ctx: slackCtx },
  { slug: "read_slack_thread", entryKey: "_single", ctx: slackCtx },
  { slug: "read_linear_issue", entryKey: "_single", ctx: linearCtx },
  { slug: "add_label", entryKey: "_single", ctx: linearCtx },
  { slug: "set_state", entryKey: "_single", ctx: linearCtx },
  { slug: "assign", entryKey: "_single", ctx: linearCtx },
  { slug: "request_access", entryKey: "_single", ctx: slackCtx },
  { slug: "connector", entryKey: "_single", ctx: slackCtx },
  { slug: "forget", entryKey: "_single", ctx: slackCtx },
  { slug: "clear_connector_override", entryKey: "_single", ctx: slackCtx },
  { slug: "clear_spend_limit", entryKey: "_single", ctx: slackCtx },
  { slug: "browser_tools", entryKey: "browser_navigate", ctx: slackCtx },
  { slug: "browser_tools", entryKey: "browser_screenshot", ctx: slackCtx },
];
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
      SLUGS.includes(slug),
      `${f} uses defineDynamic but has no row in this test's inventory — pre-register its entry (access/window-gated.ts preRegisterDynamicEntry) and add the (slug, entryKey) row here`,
    );
    ok(
      !src.slice(dynAt).includes("defineTool("),
      `${f} has an inline defineTool literal inside/after its defineDynamic call — that rides eve's BUILD-ORDER-COUNTER transform (nondeterministic durable stepIds across deploys). Factor it to a top-level const + preRegisterDynamicEntry.`,
    );
    ok(
      src.includes("preRegisterDynamicEntry("),
      `${f} never calls preRegisterDynamicEntry — its entry only registers at resolve time and a cold-resumed session silently skips the tool`,
    );
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
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(c.env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const resolved = (await resolvers.get(c.slug)!({}, c.ctx)) as Record<string, unknown> | null;
    const entry =
      resolved !== null && typeof resolved.execute !== "function" && c.entryKey in resolved
        ? (resolved[c.entryKey] as Record<string, unknown>)
        : resolved;
    ok(entry !== null && typeof entry.execute === "function", `${c.slug}:${c.entryKey} arms on its happy-path session`);
    const names = replayStepNames(c.slug, c.entryKey);
    eq((entry!.__executeStepFn as { stepId?: string } | undefined)?.stepId, names.execute, `${c.slug}:${c.entryKey} resolver returns the STAMPED entry (durable metadata will name the module-load step)`);
    ok(entry!.__closureVars !== undefined, `${c.slug}:${c.entryKey} entry carries __closureVars (a metadata row without it is skipped on replay)`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log("4. installed-eve replay (no skip):");
{
  const require2 = createRequire(import.meta.url);
  const eveRoot = dirname(require2.resolve("eve/package.json"));
  const lifecycle = (await import(pathToFileURL(join(eveRoot, "dist/src/context/dynamic-tool-lifecycle.js")).href)) as {
    replayDynamicSessionTools(meta: readonly unknown[], ctx?: unknown): { name: string; execute: unknown }[];
  };
  const meta = CASES.map((c) => ({
    name: c.slug,
    description: `replay ${c.slug}`,
    inputSchema: { type: "object", properties: {} },
    resolverSlug: c.slug,
    entryKey: c.entryKey,
    executeStepFnName: replayStepNames(c.slug, c.entryKey).execute,
    closureVars: {},
  }));
  const replayed = lifecycle.replayDynamicSessionTools(meta);
  eq(replayed.length, CASES.length, `eve's replay path finds ALL ${CASES.length} entries (a skip here is BUG A live again)`);
}

console.log(`\ndynamic-tool-replay: ${n} assertions passed.`);
