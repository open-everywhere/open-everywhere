import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceScopedMount } from "../agent/access/source-scoped-mount.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { checkSourceGate, SOURCE_SCOPED_TOOLS, GENERIC_READ_VERBS, type SourceToolFile } from "../agent/access/source-gate-manifest.js";
import { assertTurnSurface, isUnifiedWindowContext, channelPlatform, type BindableContext } from "../agent/identity/binding.js";
import { defineDomain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function mk(kind: string, attrs: Record<string, string>, continuationToken?: string): BindableContext {
  return {
    channel: { kind, ...(continuationToken ? { continuationToken } : {}) },
    session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "slack-user" } } },
  } as unknown as BindableContext;
}

const payments = defineDomain({
  name: "payments",
  channels: ["slack/T_ENG/C_TXN", "github/acme/api", "notion/W_ACME/P_PAY"],
  ambientSupervisor: true,
  mode: "unified",
});
const hr = defineDomain({ name: "hr", channels: ["slack/T_ENG/C_HR"], ambientSupervisor: true });
const domains = [payments, hr];

const setFlag = (v: boolean | undefined) => {
  if (v === undefined) resetSettingsForTest();
  else overrideSettingsForTest({ tools: { sourceScopedMount: v } });
};

setFlag(undefined);
{
  const uni = mk("unified", { oe_platform: "github", oe_sources: "github" });
  ok(sourceScopedMount(uni, "slack", () => domains) === true, "flag-OFF: a unified window mounts the Slack reader regardless of sources (arm-on-unified, byte-identical)");
  ok(sourceScopedMount(uni, "notion", () => domains) === true, "flag-OFF: a unified window mounts the Notion reader regardless of sources (byte-identical)");

  const slackSess = mk("slack", {});
  ok(sourceScopedMount(slackSess, "slack", () => domains) === true, "flag-OFF: a Slack session mounts the Slack reader");
  ok(sourceScopedMount(slackSess, "notion", () => domains) === false, "flag-OFF: a Slack session does NOT mount the Notion reader");

  const ghSess = mk("github", {});
  ok(sourceScopedMount(ghSess, "slack", () => domains) === false, "flag-OFF: a GitHub session does NOT mount the Slack reader");

  const ctxs = [uni, slackSess, ghSess, mk("unified", {}), mk("channel:unified", { oe_platform: "notion" }), mk("notion", {})];
  for (const c of ctxs) {
    for (const p of ["slack", "notion", "github"]) {
      const oldGuard = isUnifiedWindowContext(c) || channelPlatform(c) === p;
      ok(sourceScopedMount(c, p, () => domains) === oldGuard, `flag-OFF equivalence: sourceScopedMount(${(c.channel as { kind: string }).kind}, ${p}) === (isUnified || platform===${p})`);
    }
  }
}

setFlag(true);
{
  const multi = mk("unified", { oe_platform: "slack", oe_sources: "slack,github,notion" });
  ok(sourceScopedMount(multi, "slack", () => domains) === true, "flag-ON: a multi-source window mounts the Slack reader (slack ∈ sources)");
  ok(sourceScopedMount(multi, "notion", () => domains) === true, "flag-ON: a multi-source window mounts the Notion reader (notion ∈ sources)");

  const soloGh = mk("unified", { oe_platform: "github", oe_sources: "github" });
  ok(sourceScopedMount(soloGh, "slack", () => domains) === false, "flag-ON: a solo-GitHub window does NOT mount the Slack reader (slack ∉ sources) — the topology narrowing");
  ok(sourceScopedMount(soloGh, "notion", () => domains) === false, "flag-ON: a solo-GitHub window does NOT mount the Notion reader (notion ∉ sources)");

  const recompute = mk("unified", { oe_platform: "slack" }, "oe-dom:payments:oe-sup:g1");
  ok(sourceScopedMount(recompute, "slack", () => domains) === true, "flag-ON: no stamp → recompute from the window token + config mounts the Slack reader (slack ∈ payments sources)");
  ok(sourceScopedMount(recompute, "notion", () => domains) === true, "flag-ON: recompute mounts the Notion reader (notion ∈ payments sources)");

  const degraded = mk("unified", { oe_platform: "github" });
  ok(sourceScopedMount(degraded, "slack", () => domains) === false, "flag-ON: no stamp + no window token → fail-closed to the single origin (github); Slack reader absent");
  ok(sourceScopedMount(degraded, "github", () => domains) === true, "flag-ON: fail-closed origin still mounts the origin platform's own reader (github ∈ [github])");

  ok(sourceScopedMount(mk("slack", {}), "slack", () => domains) === true, "flag-ON: a normal Slack session fail-closes to [slack] → mounts the Slack reader");
  ok(sourceScopedMount(mk("slack", {}), "notion", () => domains) === false, "flag-ON: a normal Slack session does NOT mount the Notion reader");
}

{
  const ghOriginMulti = mk("unified", { oe_platform: "github", oe_sources: "slack,github,notion" });
  ok(sourceScopedMount(ghOriginMulti, "slack", () => domains) === true, "fence-compose: the Slack reader is MOUNTED on the multi-source window (slack ∈ sources)");
  assert.throws(() => assertTurnSurface(ghOriginMulti, "slack"), /reads slack, but the message that woke this turn came from github/u, "fence-compose: yet a GitHub-origin turn calling the Slack reader is FENCED per turn (mount ≠ fence)");
  n++;
  assertTurnSurface(ghOriginMulti, "github");
  ok(true, "fence-compose: a GitHub-origin turn passes the fence for its OWN surface");
}
setFlag(undefined);

const firesWith = (problems: string[], needle: string, label: string) =>
  ok(problems.some((p) => p.includes(needle)), `${label} (got: ${JSON.stringify(problems)})`);

const armOnUnified = (platform: string) =>
  `if (!isUnifiedWindowContext(ctx as BindableContext) && channelPlatform(ctx as BindableContext) !== "${platform}") return null;`;
const gated = (platform: string) => `if (!sourceScopedMount(ctx as BindableContext, "${platform}", () => getConfig().loadDomains())) return null;`;

firesWith(
  checkSourceGate([{ name: "read_discord_channel", source: armOnUnified("discord") }]),
  'is NOT declared in SOURCE_SCOPED_TOOLS',
  "an un-declared per-surface tool that blanket-mounts on a unified window FAILS (the drift guard)",
);

firesWith(
  checkSourceGate([{ name: "read_slack_channel", source: "export default defineDynamic({ /* no gate */ });" }, { name: "read_slack_thread", source: gated("slack") }, { name: "read_notion_page", source: gated("notion") }]),
  'must gate its mount via sourceScopedMount',
  "a declared per-surface tool with no sourceScopedMount call FAILS",
);

firesWith(
  checkSourceGate([{ name: "read_slack_channel", source: gated("slack") + "\n" + armOnUnified("slack") }, { name: "read_slack_thread", source: gated("slack") }, { name: "read_notion_page", source: gated("notion") }]),
  'still carries the ad-hoc "arm on any unified window" guard',
  "a declared tool that keeps BOTH the source gate and the old compound guard FAILS",
);

{
  const cardGuard = 'if (channelPlatform(ctx as BindableContext) !== "slack") return null; // hide off Slack';
  const problems = checkSourceGate([
    { name: "read_slack_channel", source: gated("slack") },
    { name: "read_slack_thread", source: gated("slack") },
    { name: "read_notion_page", source: gated("notion") },
    { name: "read_notion_comments", source: gated("notion") },
    { name: "read_channel", source: "resolveReadAdapter();" },
    { name: "read_thread", source: "resolveReadAdapter();" },
    { name: "read_work_channel", source: "resolveWakeChannel();" },
    { name: "read_work_thread", source: "resolveWakeChannel();" },
    { name: "request_access", source: cardGuard },
    { name: "forget", source: cardGuard },
    { name: "clear_connector_override", source: cardGuard },
  ]);
  ok(problems.length === 0, `the approval-card bare-origin guards are NOT flagged as per-surface tools (got: ${JSON.stringify(problems)})`);
}

firesWith(
  checkSourceGate([{ name: "read_slack_channel", source: gated("slack") }, { name: "read_slack_thread", source: gated("slack") }]),
  'no such tool file was scanned (stale row',
  "a declared tool absent from the scanned surface FAILS (no stale row)",
);

ok(JSON.stringify(SOURCE_SCOPED_TOOLS) === JSON.stringify({ read_slack_channel: "slack", read_slack_thread: "slack", read_notion_page: "notion", read_notion_comments: "notion" }), "SOURCE_SCOPED_TOOLS pins the per-surface readers → their platforms (slack channel/thread + notion page/comments)");
ok(
  JSON.stringify([...GENERIC_READ_VERBS]) === JSON.stringify(["read_channel", "read_thread", "read_work_channel", "read_work_thread"]),
  "GENERIC_READ_VERBS pins the two chat read verbs and the two work read verbs",
);

const perSurfaceOk = [
  { name: "read_slack_channel", source: gated("slack") },
  { name: "read_slack_thread", source: gated("slack") },
  { name: "read_notion_page", source: gated("notion") },
  { name: "read_notion_comments", source: gated("notion") },
];

const genericWorkPair = [
  { name: "read_work_channel", source: "const { platform, adapter, container } = resolveWakeChannel(bctx, domains);" },
  { name: "read_work_thread", source: "const { platform, adapter, container } = resolveWakeChannel(bctx, domains);" },
];

firesWith(
  checkSourceGate([
    ...perSurfaceOk,
    { name: "read_channel", source: "export default defineDynamic({ async execute() {} });" },
    { name: "read_thread", source: "resolveReadAdapter(); assertTurnSurface();" },
    ...genericWorkPair,
  ]),
  "must route its per-platform access through the sources gate in execute",
  "a generic read verb that skips the execute-time source/fence gate FAILS",
);

{
  const genericOk = (name: string) => ({ name, source: "const { platform, adapter } = resolveReadAdapter(bctx, input.target.platform, safeDomains());" });
  ok(
    checkSourceGate([...perSurfaceOk, genericOk("read_channel"), genericOk("read_thread"), ...genericWorkPair]).length === 0,
    "generic verbs gating via resolveReadAdapter pass the source-gate lint",
  );
  firesWith(
    checkSourceGate([...perSurfaceOk, genericOk("read_channel")]),
    'GENERIC_READ_VERBS names "read_thread"',
    "a missing generic verb (stale GENERIC_READ_VERBS row) FAILS",
  );
}

ok(
  checkSourceGate([
    ...perSurfaceOk,
    { name: "read_channel", source: "resolveWindowSources(); assertTurnSurface();" },
    { name: "read_thread", source: "resolveReadAdapter();" },
    ...genericWorkPair,
  ]).length === 0,
  "a generic verb gating via resolveWindowSources+assertTurnSurface directly also passes",
);

{
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [join(here, "../agent/tools")];
  const providersRoot = join(here, "../../providers");
  if (existsSync(providersRoot)) {
    for (const e of readdirSync(providersRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const d = join(providersRoot, e.name, "agent", "tools");
      if (existsSync(d)) dirs.push(d);
    }
  }
  const coreTools: SourceToolFile[] = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
      .map((f) => ({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(dir, f), "utf8") })),
  );
  const problems = checkSourceGate(coreTools);
  ok(problems.length === 0, `the REAL authored tool surface carries a clean source-gate manifest (problems: ${JSON.stringify(problems)})`);
  ok(coreTools.length >= 37, `the real scan actually covered the tools dirs (saw ${coreTools.length})`);
}

console.log(`✓ ${n} source-scoped-mount assertions passed`);
