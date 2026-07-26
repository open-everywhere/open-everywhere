import { assembleAccessInstructions } from "../agent/access/instructions.js";
import { renderSurfaceGuide, renderScopeMarkdown } from "../agent/instructions/access.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo } from "../agent/memory/silo.js";
import type { BindableContext } from "../agent/identity/binding.js";
import type { EffectiveAccess } from "../agent/access/resolver.js";

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
  connections: [],
  connectorCredentials: {},
  reachableHosts: [],
  repos: [],
  plugins: [],
  skills: [],
  subagents: [],
  connectors: [],
  instructionStack: [],
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

ok(renderSurfaceGuide("telegram") === "", "an unlisted platform (e.g. telegram) renders no surface guide");
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

console.log(`✓ instructions: ${passed} assertions passed`);
