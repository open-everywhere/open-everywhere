import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { assembleAccessInstructions } from "../agent/access/instructions.js";
import { clearPendingCancelNoteAfter, setPendingCancelNote } from "../agent/channels/cancel-note.js";
import dynamicInstructions, { renderSurfaceGuide, renderScopeMarkdown, renderReadingAWake, renderSupervisorPersona, REPLY_STYLE_RUBRIC, canReceiveJudgedWake } from "../agent/instructions/access.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo } from "../agent/memory/silo.js";
import type { BindableContext } from "../agent/identity/binding.js";
import type { EffectiveAccess } from "../agent/access/resolver.js";
import { classifySessionId, taskWindowId, threadSeatWindowId, formatWindowToken, windowTokenPlatform } from "../agent/channels/window-key.js";
import { registerBotDisplayName, _resetBotDisplayNamesForTest } from "../agent/identity/bot-display-name.js";
import { registerSlackFixtureMapper, registerSlackFixtureManifest, registerSlackTestBridge } from "./_slack-test-stubs.js";
import { capabilitiesForPlatform, registerCapabilityManifest } from "../agent/identity/capabilities.js";
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
  repoCapabilities: {},
  resourceCapabilities: {},
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
  const granted = { name: "payments", credentials: [{ connector: "linear", credential: "workspace", use: "org-1" }] };
  const md = assembleAccessInstructions({ ...base, repos: ["acme/web"] }, [granted]);
  ok(md !== null && md.includes("Work surfaces your domain is granted"), "a work grant is named in the capability summary");
  ok(md!.includes("`linear`"), "…naming the granted provider");

  const capable = { ...base, plugins: ["some-plugin"] };

  const chatOnly = { name: "chat", credentials: [{ connector: "notion", credential: "channel-key", use: "other-key" }] };
  const chatMd = assembleAccessInstructions(capable, [chatOnly]);
  ok(
    chatMd !== null && !chatMd.includes("Work surfaces your domain is granted"),
    "a domain declaring only a CHAT role says nothing about work — a chat entry confers no work capability",
  );

  const none = assembleAccessInstructions(capable, [{ name: "plain" }]);
  ok(none !== null && !none.includes("Work surfaces your domain is granted"), "a domain with NO work grant says nothing about filing");
  const noDomain = assembleAccessInstructions(capable);
  ok(noDomain !== null && !noDomain.includes("Work surfaces your domain is granted"), "an unresolved domain says nothing about filing (fail closed)");

  const gh = assembleAccessInstructions({ ...base, repos: ["acme/web"] });
  ok(gh !== null && gh.includes("Work surfaces your domain is granted: `github`"), "🔴 OPE-940: a repo grant alone names github as a granted work surface");
  ok(gh!.includes("Repositories granted: `acme/web`"), "…alongside the repo list, in the same capability section");
  const ghAndLinear = assembleAccessInstructions({ ...base, repos: ["acme/web"] }, [granted]);
  ok(ghAndLinear!.includes("`github`") && ghAndLinear!.includes("`linear`"), "a repo grant and a declared work role render on ONE line, sorted");

  const both = {
    name: "kb",
    credentials: [
      { connector: "notion", credential: "team-key", use: "kb-work-key" },
      { connector: "linear", credential: "workspace", use: "org-2" },
    ],
  };
  const bothMd = assembleAccessInstructions({ ...base, repos: ["acme/web"] }, [both]);
  ok(bothMd!.includes("`linear`") && bothMd!.includes("`notion`"), "both providers' grants render from the SAME declaration field");

  const twoDomains = assembleAccessInstructions({ ...base, repos: ["acme/web"] }, [{ name: "plain" }, granted]);
  ok(twoDomains!.includes("`linear`"), "a grant on the SECOND resolved domain is still named (the union, not the first)");
}

{
  const soakAccess: EffectiveAccess = {
    ...base,
    scopeKey: "slack/T0EXAMPLE/C0EXCHAN008",
    tenantKey: "slack/T0EXAMPLE",
    surfaceKey: "slack/T0EXAMPLE/C0EXCHAN008",
    reachableHosts: [{ host: "api.github.com", viaConnection: null }],
    repos: ["example-owner/soak-scratch"],
    connectors: [],
  };
  const soakDomain = {
    name: "soak",
    credentials: [
      { connector: "notion", credential: "team-key", use: "soak-work-key" },
      { connector: "linear", credential: "workspace", use: "soak-org" },
    ],
  };

  const connectionsSection = (md: string | null): string => {
    const i = (md ?? "").indexOf("### Connections you may use");
    return i < 0 ? "" : (md ?? "").slice(i);
  };

  const grantedMd = assembleAccessInstructions(soakAccess, [soakDomain]);
  const grantedConnections = connectionsSection(grantedMd);
  const ungrantedMd = assembleAccessInstructions({ ...soakAccess, repos: [] }, [{ name: "plain" }]);
  const ungrantedConnections = connectionsSection(ungrantedMd);

  ok(grantedConnections.length > 0 && ungrantedConnections.length > 0, "(a) fixture guard: both shapes render a connections section to compare");
  ok(grantedMd!.includes("Work surfaces your domain is granted"), "(a) fixture guard: the granted shape really renders the work line");
  ok(grantedConnections.includes("Allowed connections for this channel: (none)"), "(a) fixture guard: its connection list really is empty — the exact shape the worker read");
  ok(!ungrantedMd!.includes("Work surfaces your domain is granted"), "(a) fixture guard: the ungranted shape renders no work line");

  ok(grantedConnections.includes("`linear`") && grantedConnections.includes("`notion`"), "🔴 (b) OPE-942 ACCEPTANCE: the connections section names every granted work surface — the `(none)` no longer stands unqualified");

  ok(grantedConnections.includes("It does not narrow the work surfaces"), "(c) …and states that the connection list does not narrow the work surfaces");
  ok(grantedConnections.includes("**What you can access in this channel**"), "(c2) …naming the capability section it defers to");
  ok(grantedMd!.includes("### What you can access in this channel"), "🔴 (c2) …and that section is really rendered — the cross-reference resolves");

  ok(
    grantedConnections.includes("never a reason to call a granted work surface unavailable"),
    "🔴 (d) …and refuses the measured inference outright — an empty connection list is never a reason to call a granted work surface unavailable",
  );

  ok(grantedMd!.includes("runs on the provider's own tools, never on a connection"), "(e) the work line names the route the grant is served by, not only the connector slug");
  ok(!grantedMd!.includes("`notion_search`") && !grantedMd!.includes("`read_linear_issue`"), "(e) …and names NO tool — a per-connector tool list would claim capability this renderer cannot verify");

  ok(grantedConnections !== ungrantedConnections, "🔴 (f) the connections section is no longer BYTE-IDENTICAL between a work-granted domain and an ungranted one");

  ok(ungrantedConnections.includes("do not invoke it"), "🔴 (g) NEGATIVE CONTROL: an ungranted session keeps the hard 'do not invoke it' guidance");
  ok(ungrantedConnections.includes("not** authorized"), "(g) …and the full 'not authorized' guard");
  ok(ungrantedConnections.includes("It does not narrow the work surfaces") === false, "🔴 (g) …and carries NO reconciliation paragraph — there is no work grant for the empty list to be wrong about");
  ok(ungrantedConnections.includes("`notion`") === false && ungrantedConnections.includes("`linear`") === false, "(g) …and names no work surface it was never granted");

  const notionOnly = assembleAccessInstructions(soakAccess, [{ name: "kb", credentials: [{ connector: "notion", credential: "team-key", use: "kb-key" }] }]);
  const notionOnlyConnections = connectionsSection(notionOnly);
  ok(notionOnlyConnections.includes("`notion`"), "(h) a NOTION-only grant reconciles Notion in the connections section");
  ok(notionOnlyConnections.includes("`linear`") === false, "🔴 (h) …and names Linear nowhere — the paragraph renders the SAME resolved set as the work line, not a fixed pair");

  const alsoConnected = connectionsSection(assembleAccessInstructions({ ...soakAccess, connectors: ["gcal"] }, [soakDomain]));
  ok(alsoConnected.includes("`gcal`"), "(i) fixture guard: a real connector grant renders in the list");
  ok(alsoConnected.includes("It does not narrow the work surfaces"), "(i) …and the plane split is still stated — the reconciliation is not an artefact of the list being empty");
  ok(alsoConnected.includes("`notion`") && alsoConnected.includes("`linear`"), "(i) …naming the same granted work surfaces alongside the granted connection");
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
  ok(md.includes("`react`") && !md.includes("no `react` tool"), "discord guide names its react primitive and never denies it");
  ok(!md.includes("update_reply"), "discord guide never mentions the dropped update_reply verb");
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
        reach: ["slack/T_PAY/C_PAY", "notion/W_PAY/P_PAY", "github/acme/payments-api"],
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

  ok(slackMd.includes("Slack") && slackMd.includes("Notion") && slackMd.includes("GitHub"), "unified block names the domain's wired surfaces (Slack, Notion, GitHub)");
  ok(slackMd.includes("across SEVERAL surfaces") && !slackMd.includes("reaching this team through **Notion**"), "unified block uses the cross-surface line, not a single-surface 'reaching through X' line");

  ok(slackMd.includes("turn-final text is DISCARDED"), "unified persona Reporting section is message-tool-only");
  ok(!slackMd.includes("reply` posts into the channel mid-turn"), "unified persona drops the per-surface dual-mode Reporting wording");

  ok(slackMd.includes("works on EVERY surface"), "unified persona keeps the reply-works-everywhere affirmation");
  ok(!slackMd.includes("Only the extras vary by surface"), "unified persona no longer hedges react availability in prose (per-turn runtime fence instead)");
  ok(slackMd.includes("any wake you have not yet answered"), "unified persona scopes the reply affirmation to UNANSWERED wakes (what the fence actually admits)");
  ok(
    slackMd.includes("each answer names the `wake-id` of the wake it answers"),
    "unified persona teaches per-wake ROUTING on a coalesced multi-message turn (each answer names its own wake's id)",
  );
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
        reach: ["slack/T_S/C_SOLO"],
        memory: "solo-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "solo-notes", description: "solo-domain notes", provider: "sqlite" })],
    domainsForSurface: ({ surface }) => (surface === "C_SOLO" ? ["solo-dom"] : []),
  });
  registerSlackFixtureManifest();
  const NOISE = "## Busy threads: a react instead of a low-content reply";

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
  const crossMdWithSoloFraming = crossMd
    .replace(
      "This is a cross-surface session, so your turn-final text is DISCARDED — nothing you write as the\nturn's closing prose reaches anyone.",
      "Your turn-final text is DISCARDED — nothing you write as the\nturn's closing prose reaches anyone.",
    )
    .replace(
      "The `reply` tool works on EVERY surface in this session — Slack, Notion, Linear, GitHub, all of\nthem — and on any wake you have not yet answered, not only the newest one.",
      "The `reply` tool works on any wake you have not yet answered, not only the newest one.",
    );
  ok(
    crossMdWithSoloFraming !== crossMd,
    "fixture guard: the framing swap actually matched something in crossMd — otherwise the assertion below proves nothing",
  );
  ok(
    soloMd.startsWith(crossMdWithSoloFraming),
    "solo output is the unified block, framed for its one pinned surface (OPE-787), PLUS the appended per-surface scope — still purely additive beyond that framing swap",
  );

  const soloGh = await renderScopeMarkdown({
    channel: { kind: "channel:unified", continuationToken: "oe-dom:solo-dom:win:github/acme/x:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "github" } } } },
  } as BindableContext);
  ok(!soloGh.includes(NOISE), "a solo window on a reactions:false surface adds no per-surface scope (manifest-gated, not Slack-literal)");
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
  registerSlackFixtureMapper();
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "ope544task", reach: ["slack/T_TASK/C_TASK"], mode: "unified" })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const taskToken = `oe-dom:ope544task:win:${taskWindowId("slack/T_TASK/C_TASK", "1700.5")}:oe-sup:g1`;
  ok(classifySessionId(taskToken).kind === "task", "fixture guard: the token really classifies TASK-grain — if this flips, the assertion below stops measuring what it names");
  const taskCtx: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: taskToken },
    session: { auth: { current: { attributes: { oe_platform: "slack", oe_grain: "task" } } } },
  } as BindableContext;
  const taskMd = await renderScopeMarkdown(taskCtx);
  ok(taskMd.includes(REPLY_STYLE_RUBRIC), "🔴 OPE-544: a REAL task-grain worker session reads the byte-identical reply-style rubric — the scoping is by opening phrase, never by grain, on an actual worker token");
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
        reach: ["slack/T_X/C_X", "teams/W_X/CH_X"],
        memory: "xsurf-notes",
        ambientSupervisor: true,
        mode: "unified",
      }),
      defineDomain({
        name: "slackonly",
        reach: ["slack/T_S/C_S"],
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
  ok(slackOnly.includes(IDENTIFY_GENERIC), "🔴 (c) OPE-610: a SLACK-ONLY unified domain with no configured name still renders the GENERIC identity line — a vendor name is never a substitute identity");
  ok(slackOnly.includes("Your mention/handle on Slack appears as **Test Slack Bot**"), "(c) …and carries the live Slack handle as a separate line, for self-recognition of mentions/backscroll only");

  ok(!(await md("oe-dom:xsurf:win:teams/W_X/CH_X:oe-sup:g1", "teams")).includes("Test Slack Bot"), "(d) a TEAMS solo window carries no Slack handle");
  ok((await md("oe-dom:xsurf:win:slack/T_X/C_X:oe-sup:g1", "slack")).includes("**Test Slack Bot**"), "(d) …while a SLACK solo window still carries the live Slack handle (OPE-610: a handle line, not identity)");

  const taskSolo = `oe-dom:slackonly:win:${taskWindowId("slack/T_S/C_S", "1700.5")}:oe-sup:g1`;
  const seatSolo = `oe-dom:slackonly:win:${threadSeatWindowId("slack/T_S/C_S", "1700.5")}:oe-sup:g1`;
  ok(classifySessionId(taskSolo).kind === "task", "(e) fixture guard: the token really classifies TASK-grain — if this flips, the assertion below stops measuring what it names");
  ok(classifySessionId(seatSolo).kind === "thread-seat", "(f) fixture guard: the second token really classifies THREAD-SEAT-grain");
  const taskMd = await md(taskSolo, "slack");
  ok(taskMd.includes("Your mention/handle on Slack appears as **Test Slack Bot**"), "🔴 (e) a TASK window on a ONE-surface unified domain carries the live vendor handle — the grain marker `t` is never read as a platform");
  ok(taskMd.includes(IDENTIFY_GENERIC), "(e) OPE-610: it STILL renders the generic identity line alongside the handle — a handle never displaces identity, the two coexist");
  ok((await md(seatSolo, "slack")).includes("Your mention/handle on Slack appears as **Test Slack Bot**"), "🔴 (f) …and a THREAD-SEAT window (`s/`) resolves the same way, for the same reason");

  const taskXsurf = await md(`oe-dom:xsurf:win:${taskWindowId("slack/T_X/C_X", "1700.5")}:oe-sup:g1`, "slack");
  ok(taskXsurf.includes("Your mention/handle on Slack appears as **Test Slack Bot**"), "🔴 (g) OPE-587: a TASK window on a CROSS-SURFACE domain now carries the handle of the ONE surface its windowId pins it to");
  ok(taskXsurf.includes(IDENTIFY_GENERIC), "(g) OPE-610: …alongside the generic identity line, which a handle never displaces");

  const taskXsurfTeams = await md(`oe-dom:xsurf:win:${taskWindowId("teams/W_X/CH_X", "1700.5")}:oe-sup:g1`, "teams");
  ok(!taskXsurfTeams.includes("Test Slack Bot"), "🔴 (h) NEGATIVE CONTROL: a TEAMS-pinned task window never borrows the SLACK name");
  ok(taskXsurfTeams.includes(IDENTIFY_GENERIC), "(h) …with no teams arm registered it renders the generic identity line");

  registerBotDisplayName("teams", async () => "Contoso Assistant");
  const taskXsurfTeamsArmed = await md(`oe-dom:xsurf:win:${taskWindowId("teams/W_X/CH_X", "1700.5")}:oe-sup:g1`, "teams");
  ok(taskXsurfTeamsArmed.includes("Your mention/handle on Microsoft Teams appears as **Contoso Assistant**"), "🔴 (i) OPE-587: a registered TEAMS arm gives a Teams-pinned window its own handle — the registry answers for a SECOND surface");
  ok(!taskXsurfTeamsArmed.includes("Test Slack Bot"), "(i) …and the Slack arm is not consulted for it");
  ok((await md("oe-dom:xsurf:win:teams/W_X/CH_X:oe-sup:g1", "teams")).includes("**Contoso Assistant**"), "(i) …and a SOLO Teams window resolves the same arm");
  ok((await md("oe-dom:xsurf:oe-sup:g1", "teams")).includes(IDENTIFY_GENERIC), "🔴 (i) NEGATIVE CONTROL: the CROSS-SURFACE domain window still withholds every name — arming a second arm did not widen it");
  _resetBotDisplayNamesForTest();
  registerSlackTestBridge({ botDisplayName: async () => "Test Slack Bot" });
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
  ok(slackMd.includes("Identify as this team's agent"), "🔴 OPE-610: per-surface Slack session with no configured name renders the GENERIC identity line — a vendor display name is never a substitute identity");
  ok(slackMd.includes("Your mention/handle on Slack appears as **Test Slack Bot**"), "…and carries the live Slack handle as a separate line");

  const teamsMd = await perSurface("teams", { tenant_id: "TEN1", channel_id: "CH1", channel_type: "channel" });
  ok(!teamsMd.includes("Test Slack Bot"), "NEGATIVE CONTROL: a per-surface TEAMS session never borrowed the Slack name, and still does not");
  ok(teamsMd.includes("Identify as this team's agent"), "…it renders the generic identity line");

  registerBotDisplayName("teams", async () => "Contoso Assistant");
  ok(
    (await perSurface("teams", { tenant_id: "TEN1", channel_id: "CH1", channel_type: "channel" })).includes("Your mention/handle on Microsoft Teams appears as **Contoso Assistant**"),
    "🔴 OPE-587: a per-surface TEAMS session carries the registered TEAMS arm's handle — the answer core had no way to give when vendorDisplayName branched on `platform !== \"slack\"`",
  );
  ok(
    (await perSurface("slack", { team_id: "T1", channel_id: "C_ORD", channel_type: "channel", is_private: "false", trust_checked: "true" })).includes("**Test Slack Bot**"),
    "…and the Slack session still gets the SLACK arm's handle, not the Teams one",
  );
  ok(
    (await perSurface("discord", { guild_id: "G1", channel_id: "D1", channel_type: "channel" })).includes("Identify as this team's agent"),
    "🔴 NEGATIVE CONTROL: a platform with NO registered arm still renders the generic line — arming Teams did not arm every surface",
  );
  _resetBotDisplayNamesForTest();
  registerSlackTestBridge({ botDisplayName: async () => "Test Slack Bot" });

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

{
  const supervisorCtx: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: "oe-dom:payments:oe-sup:g1" },
  } as BindableContext;

  const flat = (s: string): string => s.replace(/\s+/g, " ");

  {
    const block = flat(renderReadingAWake());
    ok(renderReadingAWake().startsWith("### Reading a wake"), "the standing 'Reading a wake' block renders unconditionally — there is no flag and no empty arm");
    for (const section of ["**What you see.**", "**How to read one.**", "**Your posture.**"]) {
      ok(block.includes(section), `the standing block keeps its section: ${section}`);
    }
    ok(block.includes('Only the message marked `trigger="true"` is the new event.'), "🔴 the standing block says only the trigger message is the new event");
    ok(block.includes("is history for context, not things to answer"), "🔴 the rest of an envelope reads as history, not as a queue");
    ok(
      block.includes("call\n`reply` with `wake` set to the id on THAT envelope") || block.includes("`reply` with `wake` set to the id on THAT envelope"),
      "🔴 the binding rule is present: answer a wake with THAT wake's own id",
    );
    ok(block.includes("any\nother id reaches the wrong people") || block.includes("any other id reaches the wrong people"), "🔴 the binding rule states the consequence of naming another id");
    ok(block.includes("your default is silence"), "🔴 the posture sentence is silence-biased");
    ok(block.includes("clearly the intended recipient"), "🔴 the posture sentence keys engagement on being the intended recipient");
    for (const recipientCase of ["mentioned", "sent a direct message", "following on from your own message", "channel memory says otherwise"]) {
      ok(block.includes(recipientCase), `the posture sentence names the intended-recipient case: ${recipientCase}`);
    }
    ok(block.includes("An addressed wake beside an ambient one changes nothing about the ambient one."), "🔴 a coalesced addressed sibling does not lower the ambient bar");
    ok(block.includes("`principal` addressed you, `peer` did not"), "🔴 the standing block glosses trust the way the render keys it: principal addressed you, peer did not");
    ok(block.includes("`relay` is a machine"), "the standing block glosses the authority floor");
    ok(block.includes("`from` says what kind of author wrote it"), "the standing block glosses `from`");
    ok(block.includes("`reason` says"), "the standing block glosses `reason`");
    ok(block.split(/\s+/).length < 400, `the standing block stays short — Tag states its whole posture in a few sentences (${block.split(/\s+/).length} words)`);
    ok(!block.includes("`channel-watch` —"), "the standing block does NOT enumerate a bar per addressing value — that is the deleted prose shape");
    ok(!block.includes("turn-final"), "the standing block does NOT restate the delivery rule — the reporting arm owns it");
  }

  const reporting = flat(renderSupervisorPersona(supervisorCtx, { messageToolOnly: true }));
  ok(reporting.includes("your turn-final text is DISCARDED"), "🔴 the reporting arm states the hard consequence: on a cross-surface session turn-final text is discarded");
  ok(reporting.includes("The `reply` tool is the ONLY way your words leave this session"), "🔴 …and names the reply tool as the only delivery route");
  ok(reporting.includes("name the wake's `wake-id` from the envelope"), "🔴 …and tells the model where to read the routing id — the envelope the wake now renders alone");
  const perSurface = flat(renderSupervisorPersona(supervisorCtx, {}));
  ok(!perSurface.includes("turn-final text is DISCARDED"), "🔴 the per-surface arm does NOT claim turn-final text is discarded — dual-mode is real there");
  const channelPersona = flat(renderSupervisorPersona(supervisorCtx, {}));
  ok(channelPersona.includes("when it's social chatter"), "🔴 the standing persona names social chatter (thanks, greetings, sign-offs) as noise");
  ok(channelPersona.includes("even right after you posted"), "🔴 …including right after the agent's own post — the exact measured failure");
  ok(channelPersona.includes("when your answer would just repeat what's been said"), "🔴 …and forbids re-answering what is already answered");
  ok(reporting.includes("That states REACH, not duty."), "the cross-surface reporting arm frames multi-wake delivery as reach, not duty");
  ok(
    reporting.includes("on a wake that did not address you the answer is usually no"),
    "the cross-surface reporting arm scopes the reply mandate: an unaddressed wake is usually a silent one",
  );
  ok(
    !reporting.includes("answer each with its OWN"),
    "🔴 the blanket per-wake reply mandate ('answer each with its OWN wake-id') is GONE from the reporting arm",
  );
  ok(reporting.includes('Never conclude that a reply "isn\'t possible here"'), "the reach half survives: a wake with a wake-id is always deliverable");
}

{
  registerSlackFixtureMapper();
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "ope771", reach: ["slack/T_771/C_771"], ambientSupervisor: true })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const unifiedSeat: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: "oe-dom:ope771:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
  } as BindableContext;
  const containerSeat: BindableContext = {
    channel: { kind: "slack", continuationToken: "C_771:oe-sup:g1" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T_771", channel_id: "C_771", channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  } as BindableContext;
  const nativeSlackSeat: BindableContext = {
    channel: { kind: "slack", continuationToken: "cse_native_771" },
    session: {
      auth: {
        current: {
          attributes: { team_id: "T_771", channel_id: "C_771", channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  } as BindableContext;

  ok(classifySessionId("C_771:oe-sup:g1").kind === "container-supervisor", "fixture guard: `${channelId}:oe-sup:g<gen>` classifies as the per-container supervisor");
  ok(classifySessionId("cse_native_771").kind === "native", "fixture guard: a blank/foreign token classifies as native");
  ok(renderSupervisorPersona(containerSeat) !== "", "fixture guard: the per-container seat IS a supervisor session — it reads the standing persona");

  ok(canReceiveJudgedWake(unifiedSeat), "predicate: the UNIFIED path is unconditionally true (an @mention there is always the judged `direct-mention` addressing, never the raw `direct` body)");
  ok(canReceiveJudgedWake(containerSeat), "predicate: a per-container SUPERVISOR (channel-watch/name-drop capable) is true on every wired platform");
  const dmSeat: BindableContext = { channel: { kind: "slack", continuationToken: "D_771:oe-dm:g1" } } as BindableContext;
  ok(classifySessionId("D_771:oe-dm:g1").kind === "dm-seat", "fixture guard: a `<channelId>:oe-dm:g<gen>` token classifies as a Slack DM seat");
  ok(canReceiveJudgedWake(dmSeat), "predicate: a Slack DM seat is true — buildDmWake always renders `direct-mention`, never a raw `direct` body");
  ok(canReceiveJudgedWake(nativeSlackSeat), "predicate: a plain native SLACK session is true — Slack never emits a raw `direct` wake at all");
  const taskOffUnified: BindableContext = { channel: { kind: "slack", continuationToken: "oe-dom:ope771tk:win:t/slack/T_771/C_771/1700.5:oe-sup:g1" } } as BindableContext;
  ok(classifySessionId("oe-dom:ope771tk:win:t/slack/T_771/C_771/1700.5:oe-sup:g1").kind === "task", "fixture guard: the `t/…` windowId classifies as task");
  ok(!canReceiveJudgedWake(taskOffUnified), "🔴 predicate: a task (worker) session is false — a worker never sees a wake envelope, even off the unified channel");
  const subagentSeat: BindableContext = { channel: { kind: "slack", continuationToken: "subagent:parent-sess:call-1" } } as BindableContext;
  ok(classifySessionId("subagent:parent-sess:call-1").kind === "subagent", "fixture guard: eve's own `subagent:<parent>:<call>` token classifies as subagent");
  ok(!canReceiveJudgedWake(subagentSeat), "🔴 predicate: a delegated subagent child is false — it never sees a wake envelope either");
  const nativeGithubSeat: BindableContext = { channel: { kind: "github", continuationToken: "cse_native_gh" } } as BindableContext;
  ok(!canReceiveJudgedWake(nativeGithubSeat), "predicate: a native GitHub session is false — its ordinary @mention flow never renders a `<wake>` envelope at all");
  const githubSupervisorSeat: BindableContext = { channel: { kind: "github", continuationToken: "github:acme/repo:oe-sup:g1" } } as BindableContext;
  ok(classifySessionId("github:acme/repo:oe-sup:g1").kind === "container-supervisor", "fixture guard: a GitHub `<owner>/<repo>:oe-sup:g<gen>` token classifies as the per-container supervisor too");
  ok(canReceiveJudgedWake(githubSupervisorSeat), "🔴 predicate: a GitHub per-repo supervisor is true independent of the Slack platform fallthrough — channel-watch judges it too");

  const unifiedMd = await renderScopeMarkdown(unifiedSeat);
  const containerMd = await renderScopeMarkdown(containerSeat);
  const nativeMd = await renderScopeMarkdown(nativeSlackSeat);
  const block = renderReadingAWake();
  ok(unifiedMd.includes(block), "the UNIFIED scope splices the 'Reading a wake' block verbatim");
  ok(containerMd.includes(block), "the PER-CONTAINER supervisor scope now carries it (OPE-771) — that seat reads judged envelopes with a key to their attributes");
  ok(nativeMd.includes(block), "a plain native Slack scope carries it too — the same predicate, the same reasoning");
  ok(containerMd.includes("### When to speak"), "the per-container seat still reads the reply bar");
  ok(containerMd.includes("### Trust grades"), "the per-container seat still reads the trust grades, which gloss `trust` and `mention`");
}

{
  registerSlackFixtureMapper();
  registerSlackFixtureManifest();
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "ope784", reach: ["slack/T_784/C_784"], ambientSupervisor: true })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const flatten = (s: string): string => s.replace(/\s+/g, " ");
  const slackAuth = {
    auth: {
      current: {
        attributes: { team_id: "T_784", channel_id: "C_784", channel_type: "channel", is_private: "false", trust_checked: "true" },
        principalId: "U1",
        principalType: "user",
      },
    },
  };
  const seatFor = (token: string): BindableContext => ({ channel: { kind: "slack", continuationToken: token }, session: slackAuth }) as BindableContext;
  const containerSeat = seatFor("C_784:oe-sup:g1");
  const threadSeat = seatFor(`oe-dom:ope784:win:${threadSeatWindowId("slack/T_784/C_784", "1700.5")}:oe-sup:g1`);

  ok(classifySessionId("C_784:oe-sup:g1").kind === "container-supervisor", "fixture guard: the per-container token classifies as container-supervisor");
  ok(classifySessionId(`oe-dom:ope784:win:${threadSeatWindowId("slack/T_784/C_784", "1700.5")}:oe-sup:g1`).kind === "thread-seat", "fixture guard: the thread token classifies as thread-seat");
  ok(capabilitiesForPlatform("slack").supervisorProseDropped === true, "fixture guard: slack's manifest carries supervisorProseDropped — the fact the arm keys on");

  const containerReporting = flatten(renderSupervisorPersona(containerSeat));
  ok(containerReporting.includes("Your turn-final text is DISCARDED"), "🔴 OPE-784 — the per-container supervisor arm states the drop");
  ok(
    containerReporting.includes("The `reply` tool is the ONLY way your own words leave this turn"),
    "🔴 …and names `reply` as the only route out",
  );
  ok(containerReporting.includes("It takes no address and there is nothing to name"), "🔴 …and says the verb carries no address, which is what this seat's `reply` really is");
  ok(!containerReporting.includes("This is a cross-surface session"), "🔴 the per-container arm does NOT open with the unified arm's cross-surface claim — false on this seat");
  ok(!containerReporting.includes("wake-id"), "🔴 the per-container arm never tells the seat to name a `wake-id` — its `reply` takes only `text`");
  ok(!containerReporting.includes("reply` posts into the channel mid-turn"), "🔴 the per-container arm drops the dual-mode wording that caused the measured prose loss");
  ok(containerReporting.includes("That states REACH, not duty"), "the per-container arm frames delivery as reach, not duty");
  ok(containerReporting.includes("Most of what wakes you still ends in `no_reply`"), "…and keeps silence as the normal ending");

  const threadReporting = flatten(renderSupervisorPersona(threadSeat));
  ok(threadReporting.includes("reply` posts into the channel mid-turn"), "negative control: a THREAD seat reads the dual-mode arm — its closing text really does post");
  ok(threadReporting.includes("Your turn-final text is DISCARDED") === false, "negative control: a thread seat is NOT told its closing text is discarded");

  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: false });
  const withoutFact = flatten(renderSupervisorPersona(containerSeat));
  ok(withoutFact.includes("Your turn-final text is DISCARDED") === false, "🔴 negative control: with supervisorProseDropped FALSE the per-container seat reads the dual-mode arm");
  ok(withoutFact.includes("reply` posts into the channel mid-turn"), "…and reads it in full, not an empty arm");
  registerSlackFixtureManifest();

  const containerScope = await renderScopeMarkdown(containerSeat);
  ok(containerScope.includes("Your turn-final text is DISCARDED"), "the per-container SCOPE carries the arm — the session reads it, not only the persona renderer");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "ope787", reach: ["notion/ws1/page1"], ambientSupervisor: true })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });

  const flatten = (s: string): string => s.replace(/\s+/g, " ");
  const soloToken = formatWindowToken({ domain: "ope787", windowId: "notion/ws1/page1", generation: 1 });
  const soloCtx: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: soloToken },
    session: { auth: { current: { attributes: { oe_platform: "notion" } } } },
  } as BindableContext;

  const sid = classifySessionId(soloToken);
  ok(sid.kind === "window" && sid.grain === "standing", "fixture guard: the solo token classifies as a standing window");
  ok(sid.kind === "window" && sid.key.windowId !== sid.key.domain, "fixture guard: the token is the EXPLICIT solo form, windowId !== domain");
  ok(windowTokenPlatform(soloToken) === "notion", "fixture guard: windowTokenPlatform reads the one pinned surface off a solo token");

  const soloReporting = flatten(renderSupervisorPersona(soloCtx, { messageToolOnly: true, pinnedPlatform: "notion" }));
  ok(soloReporting.includes("turn-final text is DISCARDED"), "the solo-window arm still states the drop");
  ok(soloReporting.includes("The `reply` tool is the ONLY way your words leave this"), "…and still names the reply tool as the only route out");
  ok(soloReporting.includes("name the wake's `wake-id` from the envelope"), "…and still requires the wake-id — the reply mechanism is unchanged, only the framing is");
  ok(!soloReporting.includes("This is a cross-surface session"), "🔴 OPE-787 — a solo (single-surface) window is NOT told it is cross-surface");
  ok(!soloReporting.includes("EVERY surface in this session"), "🔴 …and is NOT told its reply reaches every surface — it reaches one");
  ok(!soloReporting.includes("Slack, Notion, Linear, GitHub"), "🔴 …the multi-platform enumeration is gone on a one-surface window");

  const crossReporting = flatten(renderSupervisorPersona(soloCtx, { messageToolOnly: true }));
  ok(crossReporting.includes("This is a cross-surface session"), "negative control: with no pinnedPlatform the arm keeps the cross-surface claim");
  ok(crossReporting.includes("Slack, Notion, Linear, GitHub"), "negative control: …and the multi-platform reply-reach line");

  const soloScope = await renderScopeMarkdown(soloCtx);
  ok(soloScope.includes("turn-final text is DISCARDED"), "the solo-window SCOPE reads the drop (it is windowed)");
  ok(!soloScope.includes("This is a cross-surface session"), "🔴 the solo-window SCOPE does not claim cross-surface — the wiring reaches the fix, not only the direct call");
  ok(!soloScope.includes("Slack, Notion, Linear, GitHub"), "🔴 …nor lists platforms this one-surface window does not span");
}

{
  const flatten = (s: string): string => s.replace(/\s+/g, " ");
  const bareCtx = (kind: string, token: string): BindableContext =>
    ({ channel: { kind, continuationToken: token }, session: { auth: { current: { attributes: {} } } } }) as BindableContext;

  const slackSeat = bareCtx("slack", "C_811:oe-sup:g1");
  const githubSeat = bareCtx("github", "acme/repo:oe-sup:g1");
  const linearSeat = bareCtx("linear", "T_811:oe-sup:g1");
  const notionSeat = bareCtx("notion", "page-811:oe-sup:g1");

  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
  for (const platform of ["github", "linear", "notion"] as const) {
    registerCapabilityManifest(platform, { midTurnPost: true, reactions: false, supervisorProseDropped: true });
  }

  ok(classifySessionId("acme/repo:oe-sup:g1").kind === "container-supervisor", "fixture guard: the github container token classifies as container-supervisor");
  ok(classifySessionId("T_811:oe-sup:g1").kind === "container-supervisor", "fixture guard: the linear container token classifies as container-supervisor");
  ok(capabilitiesForPlatform("github").midTurnPost === true, "fixture guard: github's manifest now mounts `reply` (its arm's installation-token comment)");
  ok(capabilitiesForPlatform("linear").supervisorProseDropped === true, "fixture guard: linear declares the prose drop — the fact the arm keys on");

  const slackReporting = flatten(renderSupervisorPersona(slackSeat));
  for (const [label, seat] of [
    ["github", githubSeat],
    ["linear", linearSeat],
    ["notion", notionSeat],
  ] as const) {
    const reporting = flatten(renderSupervisorPersona(seat));
    ok(reporting.includes("Your turn-final text is DISCARDED"), `🔴 OPE-811 — the ${label} supervisor arm states the DROP`);
    ok(reporting.includes("The `reply` tool is the ONLY way your own words leave this turn"), `🔴 …and names \`reply\` as the only route out on ${label}`);
    ok(!reporting.includes("mounts no working `reply` tool"), `🔴 …and NEVER renders the retired OPE-786 no-working-reply copy on ${label}`);
    ok(!reporting.includes("what gets posted as the comment"), `…nor tells the ${label} seat its closing text is the delivery`);
    ok(reporting.includes("finish with `no_reply`"), `the ${label} arm still teaches the reply-then-silence shape`);
    ok(reporting === slackReporting, `🔴 OPE-811 — the ${label} supervisor's delivery section is BYTE-IDENTICAL to Slack's: one section, every surface`);
  }

  registerCapabilityManifest("github", { midTurnPost: false, reactions: false });
  const unwired = flatten(renderSupervisorPersona(githubSeat));
  ok(unwired.includes("mounts no working `reply` tool"), "🔴 negative control: a surface with NO mid-turn post arm still reads the no-working-reply arm");
  ok(unwired.includes("whatever you write as the FINAL text of the turn is what gets posted"), "negative control: …and is told its closing text is the delivery");
  ok(!unwired.includes("Your turn-final text is DISCARDED"), "negative control: …and is never told about a drop the host cannot honour");
  ok(!unwired.includes("`reply`,"), "negative control: that arm never instructs a `reply` call");
  registerCapabilityManifest("github", { midTurnPost: true, reactions: false, supervisorProseDropped: true });
  const threadSeat = bareCtx("linear", `oe-dom:ope811:win:${threadSeatWindowId("linear/T_811", "issue-1")}:oe-sup:g1`);
  const threadReporting = flatten(renderSupervisorPersona(threadSeat));
  ok(threadReporting.includes("reply` posts into the channel mid-turn"), "negative control: a THREAD seat still reads the dual-mode arm — the drop is container-supervisor-scoped");
  ok(!threadReporting.includes("Your turn-final text is DISCARDED"), "negative control: …and is never told its closing text is dropped");
}

{
  const md = readFileSync(new URL("../../../agent/instructions.md", import.meta.url), "utf8");
  const start = md.indexOf("\n## Approvals\n");
  ok(start >= 0, "OPE-2077: agent/instructions.md has a § Approvals heading");
  const next = md.indexOf("\n## ", start + 1);
  const section = md.slice(start, next < 0 ? undefined : next).replace(/\s+/g, " ");
  const rest = (md.slice(0, start) + (next < 0 ? "" : md.slice(next))).replace(/\s+/g, " ");
  ok(section.includes("The card is the runtime's to raise, never yours to infer."), "OPE-2077: § Approvals says the card is never the model's to infer");
  ok(section.includes("A tool that raises no card needs none."), "OPE-2077: § Approvals says a tool that raises no card needs none");
  ok(section.includes("is pre-authorised"), "OPE-2077: § Approvals says a declared domain write is pre-authorised");
  ok(section.includes("they are not asking you to bypass a gate"), "OPE-2077: § Approvals says a colleague's 'already authorised' is a fact, not a bypass ask");
  ok(section.includes("If a card is owed, the tool raises it, and you surface it then."), "OPE-2077: § Approvals says the tool raises an owed card");
  ok(section.includes("Don't route around a gate; surface what you intend to do and let a human confirm."), "OPE-2077: § Approvals still forbids routing around a gate");
  ok(rest.includes("never yours to infer") === false, "OPE-2077 negative control: the no-infer sentence is not outside § Approvals");
}

{
  const md = readFileSync(new URL("../../../agent/instructions.md", import.meta.url), "utf8");
  const start = md.indexOf("Some of these verbs live on workers rather than on a conversational seat.");
  ok(start >= 0, "OPE-2080: agent/instructions.md has the delegation paragraph");
  const end = md.indexOf("\n\n", start);
  const para = md.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
  ok(para.includes("The worker sees only your brief — not the room, not the message you are answering."), "OPE-2080: the delegation paragraph says the worker sees only the brief");
  ok(para.includes("Put every literal the task needs into the brief word for word: names, titles, tokens, times, the exact text to post or to schedule."), "OPE-2080: the delegation paragraph says every literal goes into the brief word for word");
  ok(para.includes('"As specified" or "the text they gave" points at nothing the worker can read.'), "OPE-2080: the delegation paragraph says 'as specified' points at nothing the worker can read");
  ok(para.includes("report it done only when the worker's own report says it is done."), "OPE-2080: the delegation paragraph still carries the report-done rule");
  const rest = (md.slice(0, start) + (end < 0 ? "" : md.slice(end))).replace(/\s+/g, " ");
  ok(rest.includes("points at nothing the worker can read") === false, "OPE-2080 negative control: the brief rule is not outside the delegation paragraph");
}

{
  const md = readFileSync(new URL("../../../agent/instructions.md", import.meta.url), "utf8");
  const start = md.indexOf("Some of these verbs live on workers rather than on a conversational seat.");
  ok(start >= 0, "OPE-2087: agent/instructions.md has the delegation paragraph");
  const end = md.indexOf("\n\n", start);
  const para = md.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
  ok(para.includes("You never know the id of the page or channel you are on: the channel id is opaque, and a message id is not a page id."), "OPE-2087: the delegation paragraph says the seat never knows the page id");
  ok(para.includes('For a task about "this page", tell the worker to read the current page (`page markdown current` on the notion-rest skill); never put an id you inferred into the brief.'), "OPE-2087: the delegation paragraph sends 'this page' to page markdown current and forbids an inferred id");
  ok(para.includes("Name an id only when the person named it."), "OPE-2087: the delegation paragraph allows an id only when the person named it");
  const rest = (md.slice(0, start) + (end < 0 ? "" : md.slice(end))).replace(/\s+/g, " ");
  ok(rest.includes("never put an id you inferred into the brief") === false, "OPE-2087 negative control: the inferred-id rule is not outside the delegation paragraph");
}

console.log(`✓ instructions: ${passed} assertions passed`);
