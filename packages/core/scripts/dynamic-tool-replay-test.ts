import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-dynamic-replay-")), "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
delete process.env.OE_PLATFORM;
overrideSettingsForTest({ tools: { genericReadVerbs: false } });
overrideSettingsForTest({ tools: { sourceScopedMount: false } });

import { replayStepNames } from "../agent/access/window-gated.js";
import { formatWindowToken, taskWindowId } from "../agent/channels/window-key.js";
import { registerBrowserToolkit } from "../agent/access/browser-toolkit.js";

import { registerSlackFixtureMapper, registerSlackFixtureManifest } from "./_slack-test-stubs.js";
import { overrideSettingsForTest, type AgentSettingsOverrides } from "../agent/settings/settings.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { resolvePartition } from "../agent/memory/partition.js";
import type { BindableContext } from "../agent/identity/binding.js";
registerSlackFixtureMapper();
registerSlackFixtureManifest();

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
  readonly settings?: AgentSettingsOverrides;
}
const slackCtx = { channel: { kind: "slack" }, session: { auth: { current: { attributes: {} } } } };

const SLACK_FIXTURE_SURFACE = resolvePartition(slackCtx as unknown as BindableContext).surfaceKey;
const REPLAY_DOMAINS = [
  defineDomain({
    name: "replay-fixture",
    channels: [SLACK_FIXTURE_SURFACE],
    credentials: [{ connector: "slack", credential: "work-token", use: "chat-token" }],
  }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => REPLAY_DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) =>
    REPLAY_DOMAINS.filter((d) => (d.channels ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});
const githubCtx = { channel: { kind: "github" }, session: { auth: { current: { attributes: {} } } } };
const unifiedCtx = { channel: { kind: "unified" }, session: { auth: { current: { attributes: { oe_platform: "slack" } } } } };
const taskCtx = {
  channel: { kind: "unified", continuationToken: `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.5"), generation: 2 })}` },
  session: { auth: { current: { attributes: { oe_platform: "slack", oe_grain: "task" } } } },
};
const CASES: readonly ToolCase[] = [
  { slug: "reply", entryKey: "_base", ctx: slackCtx },
  { slug: "reply", entryKey: "_single", ctx: unifiedCtx },
  { slug: "edit_reply", entryKey: "_base", ctx: slackCtx },
  { slug: "edit_reply", entryKey: "_single", ctx: unifiedCtx },
  { slug: "react", entryKey: "_single", ctx: slackCtx },
  { slug: "read_channel", entryKey: "_single", ctx: slackCtx, settings: { tools: { genericReadVerbs: true } } },
  { slug: "read_thread", entryKey: "_single", ctx: slackCtx, settings: { tools: { genericReadVerbs: true } } },
  { slug: "add_label", entryKey: "_single", ctx: githubCtx },
  { slug: "set_state", entryKey: "_single", ctx: githubCtx },
  { slug: "assign", entryKey: "_single", ctx: githubCtx },
  { slug: "create_ticket", entryKey: "_single", ctx: githubCtx },
  { slug: "request_access", entryKey: "_single", ctx: slackCtx },
  { slug: "connector", entryKey: "_single", ctx: slackCtx },
  { slug: "purge_memory", entryKey: "_single", ctx: slackCtx },
  { slug: "clear_connector_override", entryKey: "_single", ctx: slackCtx },
  { slug: "clear_spend_limit", entryKey: "_single", ctx: slackCtx },
  {
    slug: "read_routine_transcript",
    entryKey: "_single",
    ctx: slackCtx,
    env: { OE_TRANSCRIPT_RELAY_SECRET: "fixture-relay-secret", OE_PUBLIC_BASE_URL: "https://fixture.invalid" },
  },
  { slug: "browser_tools", entryKey: "browser_navigate", ctx: taskCtx },
  { slug: "browser_tools", entryKey: "browser_screenshot", ctx: taskCtx },
  { slug: "read_work_channel", entryKey: "_single", ctx: slackCtx },
  { slug: "read_work_thread", entryKey: "_single", ctx: slackCtx },
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
    const authorsDefineTool = src.includes("defineTool(");
    ok(
      !src.slice(dynAt).includes("defineTool("),
      `${f} has an inline defineTool literal inside/after its defineDynamic call — that rides eve's BUILD-ORDER-COUNTER transform (nondeterministic durable stepIds across deploys). Factor it to a top-level const + preRegisterDynamicEntry.`,
    );
    if (authorsDefineTool) {
      ok(
        src.includes("preRegisterDynamicEntry("),
        `${f} authors a defineTool entry but never calls preRegisterDynamicEntry — its toModelOutput projection would not survive eve's replay rebuild`,
      );
    }
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

console.log("3. resolver returns an UNSTAMPED entry (OPE-867 retirement):");
for (const c of CASES) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(c.env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  if (c.settings) overrideSettingsForTest(c.settings);
  try {
    const resolved = (await resolvers.get(c.slug)!({}, c.ctx)) as Record<string, unknown> | null;
    const entry =
      resolved !== null && typeof resolved.execute !== "function" && c.entryKey in resolved
        ? (resolved[c.entryKey] as Record<string, unknown>)
        : resolved;
    ok(entry !== null && typeof entry.execute === "function", `${c.slug}:${c.entryKey} arms on its happy-path session`);
    ok(!("__executeStepFn" in entry!), `${c.slug}:${c.entryKey} carries NO __executeStepFn stamp — eve derives its own step id, not OURS`);
    ok(!("__closureVars" in entry!), `${c.slug}:${c.entryKey} carries NO __closureVars stamp either`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (c.settings) overrideSettingsForTest({ tools: { genericReadVerbs: false, sourceScopedMount: false } });
  }
}

console.log("4. installed-eve replay (no skip):");
{
  const require2 = createRequire(import.meta.url);
  const eveRoot = dirname(require2.resolve("eve/package.json"));
  const lifecycle = (await import(pathToFileURL(join(eveRoot, "dist/src/context/dynamic-tool-lifecycle.js")).href)) as {
    replayDynamicSessionTools(meta: readonly unknown[], resolvers: readonly unknown[]): { name: string; execute: unknown }[];
  };
  const meta = CASES.map((c) => ({
    name: c.slug,
    description: `replay ${c.slug}`,
    inputSchema: { type: "object", properties: {} },
    resolverSlug: c.slug,
    entryKey: c.entryKey,
    callbacks: { execute: { stepId: replayStepNames(c.slug, c.entryKey).execute, closure: {} } },
  }));
  const replayed = lifecycle.replayDynamicSessionTools(meta, []);
  eq(replayed.length, CASES.length, `eve's replay path finds ALL ${CASES.length} entries fed under the alias name (the alias is a real, functioning step-registry entry)`);
}

console.log("5. native cold-resume survival against the REAL tool inventory (OPE-867):");
{
  const require2 = createRequire(import.meta.url);
  const eveRoot = dirname(require2.resolve("eve/package.json"));
  const distSrc = join(eveRoot, "dist", "src");
  const distUrl = (rel: string): string => pathToFileURL(join(distSrc, rel)).href;
  const nativeLifecycle = (await import(distUrl("context/dynamic-tool-lifecycle.js"))) as {
    dispatchDynamicToolEvent(e: unknown): Promise<void>;
    replayDynamicSessionTools(meta: readonly unknown[], resolvers: readonly unknown[]): { name: string; execute: unknown }[];
  };
  const durable = (await import(distUrl("shared/durable-dynamic-tool-callbacks.js"))) as {
    createDurableDynamicCallback<A extends unknown[], R>(i: { closure: Record<string, unknown>; callback: (c: Record<string, unknown>, ...a: A) => R; stepId: string }): (...a: A) => R;
  };
  const { defineTool: eveDefineTool } = (await import(distUrl("public/tools/index.js"))) as {
    defineTool<T extends Record<string, unknown>>(entry: T): T;
  };
  function durablize(entry: Record<string, unknown>, stepPrefix: string): Record<string, unknown> {
    const wrap = <A extends unknown[], R>(fn: (...a: A) => R, phase: string): ((...a: A) => R) =>
      durable.createDurableDynamicCallback<A, R>({ closure: {}, stepId: `${stepPrefix}:${phase}`, callback: (_c, ...a: A) => fn(...a) });
    const copy: Record<string, unknown> = { ...entry };
    copy.execute = wrap(entry.execute as (...a: unknown[]) => unknown, "execute");
    if (typeof entry.toModelOutput === "function") copy.toModelOutput = wrap(entry.toModelOutput as (...a: unknown[]) => unknown, "toModelOutput");
    const approval = entry.approval;
    if (typeof approval === "function") copy.approval = wrap(approval as (...a: unknown[]) => unknown, "approvalRequest");
    else if (approval !== null && typeof approval === "object") {
      const a = approval as { request?: unknown; response?: unknown };
      const next: Record<string, unknown> = { ...a };
      if (typeof a.request === "function") next.request = wrap(a.request as (...x: unknown[]) => unknown, "approvalRequest");
      if (typeof a.response === "function") next.response = wrap(a.response as (...x: unknown[]) => unknown, "approvalResponse");
      copy.approval = next;
    }
    return eveDefineTool(copy);
  }
  const nativeKeys = (await import(distUrl("context/keys.js"))) as {
    SessionIdKey: unknown;
    SessionDynamicToolMetadataKey: unknown;
    AuthKey: unknown;
    InitiatorAuthKey: unknown;
    ContinuationTokenKey: unknown;
  };
  const { ChannelKey } = (await import(distUrl("runtime/sessions/runtime-context-keys.js"))) as { ChannelKey: unknown };
  const REG_SYMBOL = Symbol.for("@workflow/core//registeredSteps");
  const nativeReg = (): Map<string, unknown> => (globalThis as Record<symbol, unknown>)[REG_SYMBOL] as Map<string, unknown>;

  interface FixtureCtx {
    readonly channel?: { readonly kind?: string; readonly continuationToken?: string };
    readonly session?: { readonly auth?: { readonly current?: unknown; readonly initiator?: unknown } };
  }
  function nativeCtxFor(fixture: FixtureCtx, sessionId: string): { get(k: unknown): unknown; set(k: unknown, v: unknown): void; require(k: unknown): unknown } {
    const store = new Map<unknown, unknown>();
    store.set(nativeKeys.SessionIdKey, sessionId);
    if (fixture.channel?.kind !== undefined) store.set(ChannelKey, { kind: fixture.channel.kind });
    if (fixture.channel?.continuationToken !== undefined) store.set(nativeKeys.ContinuationTokenKey, fixture.channel.continuationToken);
    if (fixture.session?.auth?.current !== undefined) store.set(nativeKeys.AuthKey, fixture.session.auth.current);
    if (fixture.session?.auth?.initiator !== undefined) store.set(nativeKeys.InitiatorAuthKey, fixture.session.auth.initiator);
    return {
      get: (k) => store.get(k),
      set: (k, v) => {
        store.set(k, v);
      },
      require: (k) => {
        if (!store.has(k)) throw new Error(`ctx.require: missing key ${String(k)}`);
        return store.get(k);
      },
    };
  }

  for (const c of CASES) {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(c.env ?? {})) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    if (c.settings) overrideSettingsForTest(c.settings);
    try {
      const stepPrefix = `oe:test-transform:${c.slug}:${c.entryKey}`;
      const rawResolver = resolvers.get(c.slug)!;
      const resolve = async (...args: unknown[]): Promise<unknown> => {
        const out = (await (rawResolver as (...a: unknown[]) => unknown)(...args)) as Record<string, unknown> | null;
        if (out === null || out === undefined) return out;
        if (typeof (out as { execute?: unknown }).execute === "function") return durablize(out, stepPrefix);
        const mapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(out)) mapped[k] = durablize(v as Record<string, unknown>, `${stepPrefix}:${k}`);
        return mapped;
      };
      const resolverDescriptor = { slug: c.slug, eventNames: ["session.started"], events: { "session.started": resolve } };
      const sessionId = `sess-native-heal-${c.slug}-${c.entryKey}`;
      const ctx = nativeCtxFor(c.ctx as FixtureCtx, sessionId);
      const event = { type: "session.started" };

      await nativeLifecycle.dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
      const metadata = ctx.get(nativeKeys.SessionDynamicToolMetadataKey) as { entryKey: string; callbacks: { execute: { stepId: string } } }[];
      const row = metadata?.length === 1 ? metadata[0] : metadata?.find((r) => r.entryKey === c.entryKey);
      ok(row !== undefined, `${c.slug}:${c.entryKey} durable metadata row exists after native resolve`);
      if (row === undefined) continue;
      ok(
        row.callbacks.execute.stepId.startsWith(stepPrefix),
        `${c.slug}:${c.entryKey} kept the CODE-OWNED durable step id through resolve (${row.callbacks.execute.stepId})`,
      );
      ok(!row.callbacks.execute.stepId.includes(sessionId), `${c.slug}:${c.entryKey} …and the id names no session, so a fresh invocation re-registers the same one`);
      ok(typeof nativeReg().get(row.callbacks.execute.stepId) === "function", `${c.slug}:${c.entryKey} warm path: step fn registered right after resolve`);

      nativeReg().delete(row.callbacks.execute.stepId);
      ok(nativeReg().get(row.callbacks.execute.stepId) === undefined, `${c.slug}:${c.entryKey} step fn removed (cold-resume simulation)`);
      const cold = nativeLifecycle.replayDynamicSessionTools([row], []);
      eq(cold.length, 1, `${c.slug}:${c.entryKey} RED: a cold-resumed replay still MOUNTS the tool with its step fn missing (0.44.0 no longer drops it silently)`);

      await nativeLifecycle.dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
      ok(typeof nativeReg().get(row.callbacks.execute.stepId) === "function", `${c.slug}:${c.entryKey} GREEN: re-registration restores the SAME code-owned step id after a simulated cold start`);
      const replayedRow = nativeLifecycle.replayDynamicSessionTools([row], []);
      eq(replayedRow.length, 1, `${c.slug}:${c.entryKey} post-heal replay returns the tool`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (c.settings) overrideSettingsForTest({ tools: { genericReadVerbs: false, sourceScopedMount: false } });
    }
  }
}

console.log(`\ndynamic-tool-replay: ${n} assertions passed.`);
