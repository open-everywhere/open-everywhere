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
  ok(md.includes("update_reply") && md.includes("react"), "slack guide names its reply/update_reply/react primitives");
  ok(!md.includes("2000 characters"), "slack guide doesn't carry Discord's char cap");
}

{
  const md = renderSurfaceGuide("discord");
  ok(md.includes("**bold**") && md.includes("2000 characters"), "discord guide names Markdown bold + the 2000-char cap");
  ok(md.includes("update_reply") && md.includes("no `react` tool"), "discord guide has update_reply but states there's no react tool");
}

{
  const md = renderSurfaceGuide("teams");
  ok(md.includes("**bold**") && md.includes("not Slack mrkdwn"), "teams guide is plain Markdown, explicitly not Slack mrkdwn");
  ok(md.includes("No `reply`, `update_reply`, or `react` tools"), "teams guide states it has none of the reply-family tools");
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
        unifiedSupervisor: true,
        crossSurfaceWindow: true,
      }),
      defineDomain({ name: "org", match: "org", unifiedSupervisorGate: true, crossSurfaceWindowGate: true }),
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

  ok(slackMd.includes("payments-notes"), "unified block carries the domain-anchored memory index (frozen snapshot)");
}

console.log(`✓ instructions: ${passed} assertions passed`);
