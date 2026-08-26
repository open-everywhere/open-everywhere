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

import { replayStepNames } from "../agent/access/window-gated.js";
import { formatWindowToken, taskWindowId } from "../agent/channels/window-key.js";
import { registerBrowserToolkit } from "../agent/access/browser-toolkit.js";

import { registerSlackFixtureMapper, registerSlackFixtureManifest } from "./_slack-test-stubs.js";
import { overrideSettingsForTest, resetSettingsForTest, type AgentSettingsOverrides } from "../agent/settings/settings.js";
import { registerConfig } from "../agent/access/config.js";
import { defineBinding, defineBundle } from "../agent/access/bundle.js";
import { defineDomain } from "../agent/memory/domain.js";
import { resolvePartition } from "../agent/memory/partition.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { registerGrantableVerb } from "../agent/access/credential-grant.js";
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
  readonly variantManaged?: boolean;
}
const slackCtx = { channel: { kind: "slack" }, session: { auth: { current: { attributes: {} } } } };

const SLACK_FIXTURE_PARTITION = resolvePartition(slackCtx as unknown as BindableContext);
const SLACK_FIXTURE_SURFACE = SLACK_FIXTURE_PARTITION.surfaceKey;
const SLACK_FIXTURE_ELSEWHERE_ID = "C_REPLAY_ELSEWHERE";
const SLACK_FIXTURE_ELSEWHERE = `${SLACK_FIXTURE_PARTITION.workspaceKey}/${SLACK_FIXTURE_ELSEWHERE_ID}`;
const REPLAY_DOMAINS = [
  defineDomain({
    name: "replay-fixture",
    channels: [SLACK_FIXTURE_SURFACE, SLACK_FIXTURE_ELSEWHERE],
    credentials: [
      { connector: "slack", credential: "work-token", use: "chat-token" },
      { connector: "notion", credential: "user-oauth", use: "user-oauth" },
    ],
  }),
];
registerConfig({
  loadBundles: () => [
    defineBundle({
      name: "coding",
      repos: ["acme/api"],
      resourceGrants: [
        { connector: "slack", resources: [`slack:channel/${SLACK_FIXTURE_ELSEWHERE_ID}`] },
        { connector: "slack", resources: ["slack:person/U_REPLAY_PERSON"] },
      ],
    }),
  ],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => REPLAY_DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) =>
    REPLAY_DOMAINS.filter((d) => (d.channels ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});
const slackDmCtx = { channel: { kind: "slack" }, session: { auth: { current: { principalId: "U_PARTNER", attributes: { channel_type: "im" } } } } };
const githubCtx = { channel: { kind: "github" }, session: { auth: { current: { attributes: {} } } } };
const unifiedCtx = { channel: { kind: "unified" }, session: { auth: { current: { attributes: { oe_platform: "slack" } } } } };
const taskCtx = {
  channel: { kind: "unified", continuationToken: `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.5"), generation: 2 })}` },
  session: { auth: { current: { attributes: { oe_platform: "slack", oe_grain: "task" } } } },
};
const CASES: readonly ToolCase[] = [
  { slug: "reply", entryKey: "_base", ctx: slackCtx, variantManaged: true },
  { slug: "reply", entryKey: "_single", ctx: unifiedCtx, variantManaged: true },
  { slug: "edit_reply", entryKey: "_base", ctx: slackCtx, variantManaged: true },
  { slug: "edit_reply", entryKey: "_single", ctx: unifiedCtx, variantManaged: true },
  { slug: "react", entryKey: "_single", ctx: slackCtx },
  { slug: "read_channel", entryKey: "_single", ctx: slackCtx },
  { slug: "read_thread", entryKey: "_single", ctx: slackCtx },
  { slug: "add_label", entryKey: "_single", ctx: githubCtx },
  { slug: "set_state", entryKey: "_single", ctx: githubCtx },
  { slug: "assign", entryKey: "_single", ctx: githubCtx },
  { slug: "create_ticket", entryKey: "_single", ctx: githubCtx },
  { slug: "post_message", entryKey: "_single", ctx: slackCtx },
  { slug: "dm_person", entryKey: "_single", ctx: slackCtx },
  { slug: "set_dm_delivery", entryKey: "_single", ctx: slackDmCtx },
  { slug: "request_access", entryKey: "_single", ctx: slackCtx },
  { slug: "request_credential_grant", entryKey: "_single", ctx: slackCtx },
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
  { slug: "check_pr_status", entryKey: "_single", ctx: slackCtx },
  { slug: "get_pr_feedback", entryKey: "_single", ctx: slackCtx },
  { slug: "walk_pr", entryKey: "_single", ctx: slackCtx },
  { slug: "post_pr_walkthrough", entryKey: "_single", ctx: slackCtx },
  { slug: "subscribe_pr", entryKey: "_single", ctx: slackCtx },
  { slug: "search", entryKey: "_single", ctx: slackCtx },
];
const SLUGS = [...new Set(CASES.map((c) => c.slug))];

const RESOLVE_TIME_ONLY_SLUGS: ReadonlySet<string> = new Set(["grant_tools"]);

registerGrantableVerb({
  compose: () => ({ method: "GET", url: "https://api.notion.com/v1/blocks/x/children" }),
  connector: "notion",
  describe: () => "read one page",
  inputSchema: { properties: {}, type: "object" },
  resourceKind: "page",
  tier: "read",
  verb: "read_page",
});

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");

console.log("1. source scan (factored shape, closed inventory):");
{
  let scanned = 0;
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(toolsDir, f), "utf8");
    const dynAt = src.indexOf("defineDynamic(");
    if (dynAt === -1) continue;
    const slug = f.replace(/\.ts$/, "");
    if (RESOLVE_TIME_ONLY_SLUGS.has(slug)) {
      ok(true, `${f} is a resolve-time-only family (see RESOLVE_TIME_ONLY_SLUGS) — no case row, source shape still checked`);
    } else {
      scanned++;
    }
    ok(
      SLUGS.includes(slug) || RESOLVE_TIME_ONLY_SLUGS.has(slug),
      `${f} uses defineDynamic but has no row in this test's inventory — pre-register its entry (access/window-gated.ts preRegisterDynamicEntry) and add the (slug, entryKey) row here`,
    );
    const authorsDefineTool = src.includes("defineTool(");
    ok(
      !src.slice(dynAt).includes("defineTool("),
      `${f} has an inline defineTool literal inside/after its defineDynamic call — that rides eve's BUILD-ORDER-COUNTER transform (nondeterministic durable stepIds across deploys). Factor it to a top-level const + preRegisterDynamicEntry.`,
    );
    if (authorsDefineTool) {
      ok(
        src.includes("preRegisterDynamicEntry(") || src.includes("preRegisterDynamicVariants(") || src.includes("registerDynamicVariant("),
        `${f} authors a defineTool entry but registers it through none of the three doors (preRegisterDynamicEntry / preRegisterDynamicVariants / registerDynamicVariant) — its durable descriptor would be missing and eve would drop the resolver's whole result`,
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
    if (c.settings) resetSettingsForTest();
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
    callbacks: { execute: { closure: {} } },
  }));
  const replayed = lifecycle.replayDynamicSessionTools(meta, []);
  eq(replayed.length, CASES.length, `eve's replay path mounts ALL ${CASES.length} durable rows back into tools`);
}

console.log("5. durable callback descriptors across the REAL tool inventory (OPE-867/OPE-903):");
{
  const require2 = createRequire(import.meta.url);
  const eveRoot = dirname(require2.resolve("eve/package.json"));
  const distSrc = join(eveRoot, "dist", "src");
  const distUrl = (rel: string): string => pathToFileURL(join(distSrc, rel)).href;
  const nativeLifecycle = (await import(distUrl("context/dynamic-tool-lifecycle.js"))) as {
    dispatchDynamicToolEvent(e: unknown): Promise<void>;
    replayDynamicSessionTools(meta: readonly unknown[], resolvers: readonly unknown[]): { name: string; execute: unknown }[];
  };
  const nativeKeys = (await import(distUrl("context/keys.js"))) as {
    SessionIdKey: unknown;
    SessionDynamicToolMetadataKey: unknown;
    AuthKey: unknown;
    InitiatorAuthKey: unknown;
    ContinuationTokenKey: unknown;
  };
  const { ChannelKey } = (await import(distUrl("runtime/sessions/runtime-context-keys.js"))) as { ChannelKey: unknown };
  const nativeDurable = (await import(distUrl("shared/durable-dynamic-tool-callbacks.js"))) as {
    lookupDurableDynamicCallback(toolName: string, phase: string): ((c: Record<string, unknown>, ...a: unknown[]) => unknown) | undefined;
  };

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
      const resolverDescriptor = { slug: c.slug, eventNames: ["session.started"], events: { "session.started": resolvers.get(c.slug)! } };
      const sessionId = `sess-native-heal-${c.slug}-${c.entryKey}`;
      const ctx = nativeCtxFor(c.ctx as FixtureCtx, sessionId);
      const event = { type: "session.started" };

      await nativeLifecycle.dispatchDynamicToolEvent({ ctx, resolvers: [resolverDescriptor], event, messages: [] });
      const metadata = ctx.get(nativeKeys.SessionDynamicToolMetadataKey) as { name: string; entryKey: string; callbacks: { execute: Record<string, unknown> } }[];
      const row = metadata?.length === 1 ? metadata[0] : metadata?.find((r) => r.entryKey === c.entryKey);
      ok(row !== undefined, `${c.slug}:${c.entryKey} durable metadata row exists after native resolve`);
      if (row === undefined) continue;
      eq(
        row.callbacks.execute,
        { closure: c.variantManaged === true ? { entryKey: c.entryKey } : {} },
        `${c.slug}:${c.entryKey} persists the descriptor's closure and nothing else`,
      );
      ok(!("stepId" in row.callbacks.execute), `${c.slug}:${c.entryKey} …and carries NO stepId — that key is refused as the pre-release shape`);
      ok(!JSON.stringify(row.callbacks.execute).includes(sessionId), `${c.slug}:${c.entryKey} …and names no session, so a fresh invocation rebinds the same identity`);
      ok(
        typeof nativeDurable.lookupDurableDynamicCallback(row.name, "execute") === "function",
        `${c.slug}:${c.entryKey} …and resolve BOUND the live callback under (${row.name}, execute) — the second half eve validates`,
      );
      const replayedRow = nativeLifecycle.replayDynamicSessionTools([row], []);
      eq(replayedRow.length, 1, `${c.slug}:${c.entryKey} eve replays the durable row back into a mounted tool`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (c.settings) resetSettingsForTest();
    }
  }
}

console.log(`\ndynamic-tool-replay: ${n} assertions passed.`);
