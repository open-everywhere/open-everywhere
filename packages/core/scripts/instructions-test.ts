import { assembleAccessInstructions } from "../agent/access/instructions.js";
import { renderSurfaceGuide } from "../agent/instructions/access.js";
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

console.log(`✓ instructions: ${passed} assertions passed`);
