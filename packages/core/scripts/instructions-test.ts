import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { assembleAccessInstructions } from "../agent/access/instructions.js";
import { clearPendingCancelNoteAfter, setPendingCancelNote } from "../agent/channels/cancel-note.js";
import dynamicInstructions, { renderSurfaceGuide, renderScopeMarkdown, REPLY_STYLE_RUBRIC } from "../agent/instructions/access.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo } from "../agent/memory/silo.js";
import type { BindableContext } from "../agent/identity/binding.js";
import type { EffectiveAccess } from "../agent/access/resolver.js";
import { classifySessionId, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import { registerSlackFixtureMapper, registerSlackTestBridge } from "./_slack-test-stubs.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const base: EffectiveAccess = {
  mode: "channel",
  scopeKey: "slack/T1/C1",
  tenantKey: "slack/T1",
  surfaceKey: "slack/T1/C1",
  domains: [],
  connections: [],
  connectorCredentials: {},
  connectorContentOrigin: {},
  reachableHosts: [],
  repos: [],
  awsRoles: [], approvers: [],
  plugins: [],
  skills: [],
  subagents: [],
  connectors: [],
  instructionStack: [],
  preApprovalRules: [],
  warnings: [],
};

ok(assembleAccessInstructions(base) === null, "bare scope -> null (no scope-specific instructions, no connector noise)");

{
  const md = assembleAccessInstructions({ ...base, connectors: ["notion", "linear-mcp"] });
  ok(md !== null && md.includes("Connections you may use"), "a connector grant emits the allowlist section");
  ok(md!.includes("`notion`") && md!.includes("`linear-mcp`"), "granted connectors are listed");
  ok(md!.includes("Use **only**") && md!.includes("not** authorized"), "guard language tells the model to stay inside its grant");
}

{
  const md = assembleAccessInstructions({ ...base, repos: ["acme/web"] });
  ok(md !== null && md.includes("Connections you may use"), "a scope with other caps still states its connector boundary");
  ok(md!.includes("(none)"), "an empty grant on a capable scope reads as '(none)', not omitted (fail closed)");
}

{
  const md = assembleAccessInstructions({
    ...base,
    instructionStack: [{ source: "org", text: "Be explicit about the target repo." }],
  });
  ok(md !== null && md.includes("Standing instructions") && md.includes("outrank channel memory"), "standing instructions render and are marked as outranking memory");
  ok(md!.includes("Be explicit about the target repo."), "the verbatim instruction text is included");
}

{
  const md = assembleAccessInstructions({
    ...base,
    reachableHosts: [{ host: "api.github.com", viaConnection: "gh" }],
    repos: ["acme/web"],
    plugins: ["notion-tools"],
    skills: ["notion-tools__search"],
  });
  ok(md!.includes("api.github.com") && md!.includes("(authenticated)"), "reachable hosts (and auth marker) are listed");
  ok(md!.includes("acme/web"), "granted repos are listed");
  ok(md!.includes("`notion-tools`"), "granted plugins are listed");
  ok(md!.includes("`notion-tools__search`"), "granted skills are listed");
}

{
  const md = renderSurfaceGuide("slack");
  ok(md.includes("mrkdwn") && md.includes("`<@U123>`"), "slack guide names mrkdwn + the mention token");
  ok(md.includes("`reply`") && md.includes("react"), "slack guide names its reply/react primitives");
  ok(!md.includes("update_reply"), "slack guide never mentions the dropped update_reply verb");
  ok(!md.includes("2000 characters"), "slack guide doesn't carry Discord's char cap");
}

{
  const md = renderSurfaceGuide("discord");
  ok(md.includes("**bold**") && md.includes("2000 characters"), "discord guide names Markdown bold + the 2000-char cap");
  ok(md.includes("no `react` tool") && !md.includes("update_reply"), "discord guide states there's no react tool and never mentions update_reply");
}

{
  const md = renderSurfaceGuide("teams");
  ok(md.includes("**bold**") && md.includes("not Slack mrkdwn"), "teams guide is plain Markdown, explicitly not Slack mrkdwn");
  ok(md.includes("`reply` posts a message") && md.includes("no `react` tool"), "teams guide has reply but no react tool");
  ok(!md.includes("update_reply"), "teams guide never mentions the dropped update_reply verb");
}

ok(renderSurfaceGuide("linear") === "", "an unlisted platform (e.g. linear) renders no surface guide");
ok(renderSurfaceGuide("") === "", "an empty platform renders no surface guide");

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: "payments",
        channels: ["slack/T_PAY/C_PAY", "notion/W_PAY/P_PAY", "github/acme/payments-api"],
        memory: "payments-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "payments-notes", description: "payments-domain decisions", provider: "sqlite" })],
    domainsForSurface: ({ surface }) => (["C_PAY", "P_PAY", "payments-api"].includes(surface) ? ["payments"] : []),
  });

  const unifiedCtx = (origin: string): BindableContext => ({
    channel: { kind: "channel:unified", continuationToken: "oe-dom:payments:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: origin } } } },
  });

  const slackMd = await renderScopeMarkdown(unifiedCtx("slack"));
  const notionMd = await renderScopeMarkdown(unifiedCtx("notion"));
  const githubMd = await renderScopeMarkdown(unifiedCtx("github"));

  ok(slackMd === notionMd && slackMd === githubMd, "unified block is BYTE-IDENTICAL across slack/notion/github origin deliveries (surface-neutral)");
  ok(slackMd === (await renderScopeMarkdown(unifiedCtx("slack"))), "unified block is byte-stable across consecutive resolves (no per-turn churn)");

  ok(slackMd.includes("Slack") && slackMd.includes("Notion") && slackMd.includes("Github"), "unified block names the domain's wired surfaces (Slack, Notion, Github)");
  ok(slackMd.includes("across SEVERAL surfaces") && !slackMd.includes("reaching this team through **Notion**"), "unified block uses the cross-surface line, not a single-surface 'reaching through X' line");

  ok(slackMd.includes("turn-final text is DISCARDED"), "unified persona Reporting section is message-tool-only (agrees with the per-wake mandate)");
  ok(!slackMd.includes("reply` posts into the channel mid-turn"), "unified persona drops the per-surface dual-mode Reporting wording");

  ok(slackMd.includes("works on EVERY surface"), "unified persona keeps the reply-works-everywhere affirmation");
  ok(!slackMd.includes("Only the extras vary by surface"), "unified persona no longer hedges react availability in prose (per-turn runtime fence instead)");
  ok(slackMd.includes("every wake you have not yet answered"), "unified persona scopes the reply affirmation to UNANSWERED wakes (what the fence actually admits)");
  ok(slackMd.includes("answer each with its OWN `wake-id`"), "unified persona teaches per-wake answering on a coalesced multi-message turn");
  ok(!slackMd.includes("every wake, without exception"), "unified persona drops the old unqualified 'without exception' claim");

  ok(slackMd.includes("payments-notes"), "unified block carries the domain-anchored memory index (frozen snapshot)");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: "solo-dom",
        channels: ["slack/T_S/C_SOLO"],
        memory: "solo-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "solo-notes", description: "solo-domain notes", provider: "sqlite" })],
    domainsForSurface: ({ surface }) => (surface === "C_SOLO" ? ["solo-dom"] : []),
  });
  const NOISE = "## Busy threads: react over reply";

  const crossMd = await renderScopeMarkdown({
    channel: { kind: "channel:unified", continuationToken: "oe-dom:solo-dom:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
  } as BindableContext);
  ok(!crossMd.includes(NOISE), "(a) existing single-channel CROSS-surface window (degenerate token) renders today's block — NO per-surface scope leak (the trap avoided)");

  const soloMd = await renderScopeMarkdown({
    channel: { kind: "channel:unified", continuationToken: "oe-dom:solo-dom:win:slack/T_S/C_SOLO:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
  } as BindableContext);
  ok(soloMd.includes(NOISE), "(b) solo-MODE window (windowId !== domain) renders the sole source's per-surface scope (noise doctrine)");
  ok(soloMd.startsWith(crossMd), "solo output is the unified block PLUS the appended per-surface scope (purely additive — no rewrite of the shared block)");

  const soloGh = await renderScopeMarkdown({
    channel: { kind: "channel:unified", continuationToken: "oe-dom:solo-dom:win:github/acme/x:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "github" } } } },
  } as BindableContext);
  ok(!soloGh.includes(NOISE), "a non-Slack solo window adds no Slack scope (per-surface renderers fail-soft off Slack)");
}

{
  class FakeSession {
    private readonly store = new Map<string, unknown>();
    get<T>(key: { name: string }): T | undefined {
      return this.store.get(key.name) as T | undefined;
    }
    has(key: { name: string }): boolean {
      return this.store.has(key.name);
    }
    require<T>(key: { name: string }): T {
      if (!this.has(key)) throw new Error(`missing ${key.name}`);
      return this.get(key) as T;
    }
    set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
      const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
      this.store.set(key.name, next);
      return next;
    }
    ensure<T>(key: { name: string }, create: () => T): T {
      return this.has(key) ? this.require(key) : this.set(key, create());
    }
    clearVirtualContext(): void {}
    setVirtualContext(): void {}
    *entries(): Generator<readonly [unknown, unknown]> {}
  }
  const g = globalThis as Record<PropertyKey, unknown>;
  const storageKey = Symbol.for("eve.context-storage");
  g[storageKey] ??= new AsyncLocalStorage();
  const storage = g[storageKey] as AsyncLocalStorage<unknown>;
  const inSession = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve(storage.run(new FakeSession(), fn));

  const ctx = (): BindableContext =>
    ({
      channel: { kind: "channel:unified", continuationToken: "oe-dom:payments:oe-sup:g1" },
      session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
    }) as BindableContext;

  const baseline = await renderScopeMarkdown(ctx());
  const quiet = await inSession(() => renderScopeMarkdown(ctx()));
  ok(quiet === baseline, "no cancel pending → the standing block is BYTE-IDENTICAL to today (the cache pin holds)");
  ok(!quiet.includes("CANCELLED"), "…and says nothing about a cancellation that did not happen");

  await inSession(async () => {
    setPendingCancelNote({ turnId: "t-1", steps: 4, ran: ["read_thread", "create_ticket"] });
    const md = await renderScopeMarkdown(ctx());
    ok(md.includes("CANCELLED"), "🔴 THE ACCEPTANCE: the next turn's context states the previous turn was cancelled");
    ok(md.includes("4 steps in"), "…and how far the cancelled turn got");
    ok(md.includes("`create_ticket`"), "…and names the tools that actually ran");
    ok(md.includes("effects are REAL"), "🔴 …and states their effects are real but absent from history (the anti-double-execution clause)");
    ok(md.startsWith(baseline), "the reconstruction is APPENDED LAST — every byte of the cached standing prefix is untouched");

    clearPendingCancelNoteAfter("t-2");
    ok((await renderScopeMarkdown(ctx())) === baseline, "once a later turn ends, the block returns byte-identical to the baseline");
  });
}

{
  registerSlackFixtureMapper();
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const dmCtx: BindableContext = {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: "D_PARTNER", channel_type: "im", dm_partner_trust: "internal" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  } as BindableContext;
  const dmMd = await renderScopeMarkdown(dmCtx);
  ok(dmMd.includes("### How you write"), "🔴 OPE-542 acceptance: a plain DM session now reads the reply-style rubric — it got NONE before this move");

  const channelCtx: BindableContext = {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T1", channel_id: "C_ORD", channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  } as BindableContext;
  const channelMd = await renderScopeMarkdown(channelCtx);
  ok(channelMd.includes("### How you write"), "OPE-542: an ordinary (non-supervisor) channel session also reads the reply-style rubric now");

  ok(dmMd.includes(REPLY_STYLE_RUBRIC) && channelMd.includes(REPLY_STYLE_RUBRIC), "the rendered rubric is byte-identical to the exported REPLY_STYLE_RUBRIC constant on both shapes");
}

{
  registerSlackTestBridge({ botDisplayName: async () => "Test Slack Bot" });
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: "xsurf",
        channels: ["slack/T_X/C_X", "teams/W_X/CH_X"],
        memory: "xsurf-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({
        name: "slackonly",
        channels: ["slack/T_S/C_S"],
        memory: "xsurf-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "xsurf-notes", description: "cross-surface notes", provider: "sqlite" })],
    domainsForSurface: ({ surface }) => (["C_X", "CH_X"].includes(surface) ? ["xsurf"] : surface === "C_S" ? ["slackonly"] : []),
  });

  const IDENTIFY_GENERIC = "Identify as this team's agent";
  const md = async (token: string, origin: string): Promise<string> =>
    renderScopeMarkdown({
      channel: { kind: "channel:unified", continuationToken: token },
      session: { auth: { current: { attributes: { oe_platform: origin } } } },
    } as BindableContext);

  const xsurfTeams = await md("oe-dom:xsurf:oe-sup:g1", "teams");
  const xsurfSlack = await md("oe-dom:xsurf:oe-sup:g1", "slack");
  ok(!xsurfTeams.includes("Test Slack Bot"), "🔴 (a) OPE-569 ACCEPTANCE: a cross-surface window's standing block never carries the Slack display name");
  ok(xsurfTeams.includes(IDENTIFY_GENERIC), "(a) …it renders the surface-neutral identity line instead (the wake's <channel platform> names the delivery)");
  ok(xsurfTeams === xsurfSlack, "(a) …and the block stays BYTE-IDENTICAL across a Teams and a Slack delivery (the cache pin holds)");

  overrideSettingsForTest({ identity: { name: "Aria" } });
  const namedTeams = await md("oe-dom:xsurf:oe-sup:g1", "teams");
  const namedSlack = await md("oe-dom:xsurf:oe-sup:g1", "slack");
  ok(namedTeams.includes("Your name in this workspace is **Aria**"), "🔴 (b) a configured `identity.name` reaches the assembled persona verbatim");
  ok(!namedTeams.includes("Test Slack Bot"), "(b) …and displaces the vendor display name entirely");
  ok(namedTeams === namedSlack, "(b) …still byte-identical across deliveries");
  resetSettingsForTest();

  const slackOnly = await md("oe-dom:slackonly:oe-sup:g1", "slack");
  ok(slackOnly.includes("Your name in this workspace is **Test Slack Bot**"), "(c) a SLACK-ONLY unified domain still identifies by the live Slack display name — today's behaviour, preserved");

  ok(!(await md("oe-dom:xsurf:win:teams/W_X/CH_X:oe-sup:g1", "teams")).includes("Test Slack Bot"), "(d) a TEAMS solo window carries no Slack name");
  ok((await md("oe-dom:xsurf:win:slack/T_X/C_X:oe-sup:g1", "slack")).includes("**Test Slack Bot**"), "(d) …while a SLACK solo window still identifies by the Slack display name");

  const taskSolo = `oe-dom:slackonly:win:${taskWindowId("slack/T_S/C_S", "1700.5")}:oe-sup:g1`;
  const seatSolo = `oe-dom:slackonly:win:${threadSeatWindowId("slack/T_S/C_S", "1700.5")}:oe-sup:g1`;
  ok(classifySessionId(taskSolo).kind === "task", "(e) fixture guard: the token really classifies TASK-grain — if this flips, the assertion below stops measuring what it names");
  ok(classifySessionId(seatSolo).kind === "thread-seat", "(f) fixture guard: the second token really classifies THREAD-SEAT-grain");
  const taskMd = await md(taskSolo, "slack");
  ok(taskMd.includes("Your name in this workspace is **Test Slack Bot**"), "🔴 (e) OPE-570: a TASK window on a ONE-surface unified domain still identifies by the live vendor name — the grain marker `t` is never read as a platform");
  ok(!taskMd.includes(IDENTIFY_GENERIC), "(e) …and it does NOT fall back to the generic identity line");
  ok((await md(seatSolo, "slack")).includes("Your name in this workspace is **Test Slack Bot**"), "🔴 (f) …and a THREAD-SEAT window (`s/`) resolves the same way, for the same reason");

  const taskXsurf = await md(`oe-dom:xsurf:win:${taskWindowId("slack/T_X/C_X", "1700.5")}:oe-sup:g1`, "slack");
  ok(!taskXsurf.includes("Test Slack Bot"), "🔴 (g) NEGATIVE CONTROL: a TASK window on a CROSS-SURFACE domain carries NO vendor name");
  ok(taskXsurf.includes(IDENTIFY_GENERIC), "(g) …it renders the generic identity line instead");
}

{
  registerSlackTestBridge({ botDisplayName: async () => "Test Slack Bot" });
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const perSurface = async (kind: string, attributes: Record<string, string>): Promise<string> =>
    renderScopeMarkdown({
      channel: { kind },
      session: { auth: { current: { attributes, principalId: "U1", principalType: "user" } } },
    } as BindableContext);

  const slackMd = await perSurface("slack", { team_id: "T1", channel_id: "C_ORD", channel_type: "channel", is_private: "false", trust_checked: "true" });
  ok(slackMd.includes("Your name in this workspace is **Test Slack Bot**"), "per-surface Slack session still identifies by the live Slack display name (unchanged)");

  const teamsMd = await perSurface("teams", { tenant_id: "TEN1", channel_id: "CH1", channel_type: "channel" });
  ok(!teamsMd.includes("Test Slack Bot"), "NEGATIVE CONTROL: a per-surface TEAMS session never borrowed the Slack name, and still does not");
  ok(teamsMd.includes("Identify as this team's agent"), "…it renders the generic identity line");

  overrideSettingsForTest({ identity: { name: "Aria" } });
  ok((await perSurface("teams", { tenant_id: "TEN1", channel_id: "CH1", channel_type: "channel" })).includes("**Aria**"), "🔴 a configured name gives a TEAMS per-surface session a real name — the answer core could not give before");
  ok((await perSurface("slack", { team_id: "T1", channel_id: "C_ORD", channel_type: "channel", is_private: "false", trust_checked: "true" })).includes("**Aria**"), "…and the SAME name on Slack — one canonical name, every surface");
  resetSettingsForTest();
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const ctx = {
    channel: { kind: "teams" },
    session: { auth: { current: { attributes: { tenant_id: "TEN1", channel_id: "CH1", channel_type: "channel" }, principalId: "U1", principalType: "user" } } },
  } as BindableContext;
  type ResolveCtx = Parameters<NonNullable<(typeof dynamicInstructions.events)["session.started"]>>[1];

  for (const event of ["session.started", "turn.started"] as const) {
    const handler = dynamicInstructions.events[event];
    ok(handler !== undefined, `${event}: the dynamic instructions resolver is registered`);
    const def = await handler!(undefined, ctx as unknown as ResolveCtx);
    ok(def !== null && typeof def === "object", `${event}: the resolver returns an instructions definition`);
    ok("content" in def!, `${event}: the definition uses the typed \`content\` key`);
    ok(def!.content === (await renderScopeMarkdown(ctx)), `${event}: \`content\` is byte-identical to renderScopeMarkdown(ctx) — the migration changed no prompt bytes`);
    ok((def!.content ?? "").length > 0, `${event}: the rendered block is non-empty (the byte assertion above is not comparing two empty strings)`);
    ok(("markdown" in def!) === false, `${event}: the deprecated \`markdown\` key is absent`);
    ok(def!.role === "system", `${event}: the role is "system" (ephemeral prompt text), not "user" (durable history)`);
  }

  const tsSources = (dir: URL): URL[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const child = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
      return e.isDirectory() ? tsSources(child) : e.name.endsWith(".ts") ? [child] : [];
    });
  const agentSources = tsSources(new URL("../agent/", import.meta.url)).map((u) => ({ url: u, src: readFileSync(u, "utf8") }));
  ok(agentSources.length > 100, `the source scan walked the whole agent tree (${agentSources.length} .ts files) — it is not looking at an empty directory`);
  ok(
    agentSources.filter((f) => /defineInstructions\(\s*\{\s*content\s*:/.test(f.src)).length === 1,
    "exactly ONE core agent module calls defineInstructions, and it uses the typed `content` key",
  );
  const deprecated = agentSources.filter((f) => /defineInstructions\(\s*\{\s*markdown\b/.test(f.src)).map((f) => f.url.pathname);
  ok(deprecated.length === 0, `no core agent module calls defineInstructions with the deprecated \`markdown\` key (found: ${deprecated.join(", ")})`);
}

console.log(`✓ instructions: ${passed} assertions passed`);
