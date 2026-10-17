import assert from "node:assert/strict";
import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("agent-setup");
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();
import { registerConfig, type AccessRequestsConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { renderAgentSetup, SETUP_JARGON, type AgentSetupAnswer, type AgentSetupFacts } from "../agent/status/agent-setup.js";
import agentVersionTool from "../agent/tools/agent_version.js";
import { gatherAgentSetupFacts, seatSetupFacts } from "../agent/status/agent-setup-live.js";
import { renderSeatSetupSection } from "../agent/status/agent-setup.js";
import { renderScopeMarkdown } from "../agent/instructions/access.js";
import { personTextFaults } from "../agent/channels/person-text.js";
import { LEAN_SEAT_TOOLS } from "../agent/access/lean-seat.js";
import { REPLY_STYLE_RUBRIC } from "../agent/instructions/access.js";
import { _resetStatusRegistriesForTest, registerSurfaceStatusReporter } from "../agent/ops/status.js";
import { clearProviderSelection, declareProviderSelection } from "../agent/access/provider-selection.js";
import { recordGitHubInstallation } from "../agent/scm/installations.js";
import readDocsTool from "../agent/tools/read_docs.js";
import { registerDocs } from "../agent/docs/registry.js";
import { docUrl } from "../agent/ops/quickstart.js";
import { resetGitHubApp } from "../agent/scm/provider.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const personFacing = (a: AgentSetupAnswer): string[] => [a.you, a.admins, ...a.connectedTo, ...a.adminCanDoNow, ...a.notYet.flatMap((g) => [g.what, g.step])];
const jargonIn = (s: string): string[] => SETUP_JARGON.filter((re) => re.test(s)).map(String);

const base: AgentSetupFacts = {
  asker: "U_ME",
  askerPlatform: "slack",
  standing: { kind: "org-admin" },
  orgAdmins: ["slack/T1/U_ME"],
  surfaces: [{ platform: "slack", installed: "yes" }],
  connectors: [],
  repos: [],
  github: { mode: "app", appConfigured: false, tokenSet: false },
  configChanges: { adminChannel: false, appInstalled: "no" },
};
const READY = { repo: "acme/agent-config", adminChannel: true } as const;

const branches: Array<[string, AgentSetupFacts]> = [];
const render = (name: string, f: AgentSetupFacts): AgentSetupAnswer => {
  branches.push([name, f]);
  return renderAgentSetup(f);
};

{
  const a = render("fresh install", { ...base, asker: "U_NEW", standing: { kind: "member" }, orgAdmins: [] });
  ok(a.you === "You're not an admin, and no admins are set up yet.", `§1 fresh install: the asker reads that no admins exist yet (saw: ${a.you})`);
  ok(/No admins are set up yet/.test(a.admins), "§1 fresh install: the roster line says no admins are set up yet");
  ok(a.notYet.length === 0 && a.forOperator.length === 0, "§1 fresh install: a non-admin reads no gaps and no settings");
  ok(a.connectedTo.includes("Slack: installed") && a.connectedTo.includes("GitHub: not connected"), `§1 fresh install: connections are named (saw: ${a.connectedTo.join(" | ")})`);
}
{
  const a = render("installer is the admin, nothing set up", base);
  ok(a.you === "You're an admin.", "§1 🔴 the incident's asker, who is on the roster, reads \"You're an admin.\"");
  ok(a.admins === "The admin is you.", `§1 the sole admin reads as "you" (saw: ${a.admins})`);
  ok(a.notYet.length === 1 && /Changing my setup from chat is off/.test(a.notYet[0]!.what), "§1 an admin reads that config changes from chat are off");
  ok(a.forOperator.some((s) => s.startsWith("OE_ACCESS_CONFIG_REPO")) && a.forOperator.some((s) => s.startsWith("OE_ACCESS_ADMIN_CHANNEL")), "§1 the operator detail names both missing settings");
  ok(a.adminCanDoNow.some((s) => /spending limit/.test(s)) && !a.adminCanDoNow.some((s) => /pull request/.test(s)), "§1 the runtime controls are listed, and the config changes are NOT while they cannot work");
}
{
  const a = render("repo set, no GitHub at all", { ...base, configChanges: { ...READY, appInstalled: "no" } });
  ok(a.notYet.length === 1 && /not connected to it/.test(a.notYet[0]!.what) && /acme\/agent-config/.test(a.notYet[0]!.step), "§1 no GitHub credential: the gap names GitHub and the repository");
}
{
  const a = render("app set up, not installed on the repo", {
    ...base,
    github: { mode: "app", appConfigured: true, appSlug: "acme-oe", tokenSet: false },
    configChanges: { ...READY, appInstalled: "no" },
  });
  ok(a.notYet.length === 1, "§1 🔴 the GitHub app missing from the repository is a gap");
  ok(/needs the GitHub app on acme\/agent-config, and I can't find it installed for acme\./.test(a.notYet[0]!.what), `§1 the gap says what is missing (saw: ${a.notYet[0]?.what})`);
  ok(a.notYet[0]!.step.includes("https://github.com/apps/acme-oe/installations/new"), "§1 the one step carries the app's install page");
  ok(!a.adminCanDoNow.some((s) => /pull request/.test(s)), "§1 config changes are not offered while the app is missing");
}
{
  const a = render("app installation cannot be read", {
    ...base,
    github: { mode: "app", appConfigured: true, appSlug: "acme-oe", tokenSet: false },
    configChanges: { ...READY, appInstalled: "unknown" },
  });
  ok(a.notYet.length === 1 && /can't confirm/.test(a.notYet[0]!.what), "§1 an unreadable installation is said as unknown, never as installed");
}
{
  const a = render("everything ready", {
    ...base,
    github: { mode: "app", appConfigured: true, appSlug: "acme-oe", tokenSet: false },
    configChanges: { ...READY, appInstalled: "yes" },
    connectors: ["notion"],
    repos: ["acme/web"],
  });
  ok(a.notYet.length === 0 && a.forOperator.length === 0, "§1 everything ready: no gaps");
  ok(a.adminCanDoNow.some((s) => /change my setup from chat/.test(s) && /pull request that an admin merges/.test(s)), "§1 everything ready: config changes from chat are offered");
  ok(a.connectedTo.includes("GitHub: the app is installed for acme"), `§1 an admin reads which owner the app is installed for (saw: ${a.connectedTo.join(" | ")})`);
  ok(a.adminCanDoNow.includes("stop everything I'm doing at once, and start me again"), "§1 an org admin can start me again");
  ok(a.connectedTo.includes("Also connected here: Notion") && a.connectedTo.includes("Repositories I can work on here: acme/web"), "§1 the room's services and repositories are listed");
}
{
  const a = render("personal access token mode", { ...base, github: { mode: "token", appConfigured: false, tokenSet: true }, configChanges: { ...READY, appInstalled: "no" } });
  ok(a.notYet.length === 0, "§1 in token mode the token is enough for the pull requests, so it is no gap");
  ok(a.connectedTo.includes("GitHub: connected with a personal access token, not the app"), "§1 the token connection is said plainly");
  ok(a.forOperator.some((l) => /GITHUB_WEBHOOK_SECRET/.test(l) && /"source-control", give it the new secret/.test(l) && /"full", delete it/.test(l)), "§1 OPE-2530 the admin read says the app brings its own webhook secret, and what to do with the old webhook for each variant");
  ok(a.forOperator.some((l) => /move to the GitHub app/.test(l) && /surface_app_create/.test(l) && /source-control/.test(l) && /deployment's environment/.test(l) && /redeploy/.test(l) && l.indexOf("redeploy") < l.indexOf("install the app") && /github\.auth to "app"/.test(l) && /Nothing else changes/.test(l)), `§1 🔴 OPE-2530 the admin read names the one-step move to the app (saw: ${a.forOperator.join(" | ")})`);
}
{
  const a = render("personal access token mode, no token", { ...base, github: { mode: "token", appConfigured: true, appSlug: "acme-oe", tokenSet: false }, configChanges: { ...READY, appInstalled: "yes" } });
  ok(a.connectedTo.includes("GitHub: not connected"), "§1 🔴 token mode with no token reads not connected, even with the app's secrets set");
  ok(a.notYet.some((g) => /needs GitHub/.test(g.what) && /personal access token/.test(g.step)), "§1 token mode with no token names the token as the one step");
}
{
  const a = render("app mode, token set, no app", { ...base, github: { mode: "app", appConfigured: false, tokenSet: true }, configChanges: { ...READY, appInstalled: "no" } });
  ok(a.connectedTo.includes("GitHub: not connected"), "§1 🔴 app mode never reads a set token as a connection");
  ok(a.notYet.some((g) => /needs GitHub/.test(g.what)), "§1 🔴 app mode with only a token is a gap: the token is not a fallback");
  ok(a.forOperator.some((l) => /GITHUB_TOKEN is set but not used/.test(l)), "§1 the admin read names the unused token and the setting that would use it");
}
{
  const a = render("member, two admins", {
    ...base,
    asker: "U_ME",
    standing: { kind: "member" },
    orgAdmins: ["slack/T1/U_ANA", "slack/T1/U_SAM"],
    github: { mode: "app", appConfigured: true, appSlug: "acme-oe", tokenSet: false },
    configChanges: { ...READY, appInstalled: "no" },
  });
  ok(a.you === "You're not an admin. <@U_ANA> and <@U_SAM> are.", `§1 a member reads who the admins are, as mentions (saw: ${a.you})`);
  ok(a.notYet.length === 0 && a.forOperator.length === 0, "§1 a member reads no gaps and no settings");
  ok(a.adminCanDoNow.length === 1 && /something an admin does/.test(a.adminCanDoNow[0]!), "§1 a member is told an admin does it");
  ok(!personFacing(a).some((s) => s.includes("acme/agent-config")), "§1 🔴 a member never reads the deployment's own repository");
}
{
  const a = render("member, one admin", { ...base, asker: "U_ME", standing: { kind: "member" }, orgAdmins: ["slack/T1/U_ANA"] });
  ok(a.you === "You're not an admin. <@U_ANA> is.", `§1 one admin reads "is" (saw: ${a.you})`);
}
{
  const a = render("domain admin", {
    ...base,
    standing: { kind: "domain-admin", domain: "payments" },
    orgAdmins: ["slack/T1/U_ANA"],
    roomDomain: { name: "payments", title: "the payments team", admins: ["slack/T1/U_ME"] },
  });
  ok(a.you === "You're an admin for the payments team.", `§1 a domain admin reads which domain (saw: ${a.you})`);
  ok(a.admins === "The admin is <@U_ANA>. For the payments team, you are an admin as well.", `§1 the room's domain admins get their own sentence (saw: ${a.admins})`);
}
{
  const a = render("counted room admins", { ...base, standing: { kind: "member" }, orgAdmins: ["slack/T1/U_ANA"], roomDomain: { name: "ops", title: "ops", admins: ["discord/300000000000000104", "discord/300000000000000105"] } });
  ok(a.admins === "The admin is <@U_ANA>. For ops, 2 people on Discord are admins as well.", `§1 a counted room list reads "are admins" (saw: ${a.admins})`);
  const b = render("one counted room admin", { ...base, standing: { kind: "member" }, orgAdmins: ["slack/T1/U_ANA"], roomDomain: { name: "ops", title: "ops", admins: ["discord/300000000000000104"] } });
  ok(b.admins === "The admin is <@U_ANA>. For ops, one person on Discord is an admin as well.", `§1 one counted room admin reads "is an admin" (saw: ${b.admins})`);
}
{
  const a = render("room admins only", { ...base, asker: "U_ME", standing: { kind: "member" }, orgAdmins: [], roomDomain: { name: "ops", title: "ops", admins: ["slack/T1/U_ANA"] } });
  ok(a.you === "You're not an admin here. <@U_ANA> is the admin for ops.", `§1 🔴 an empty org list with room admins is not "no admins" (saw: ${a.you})`);
  ok(a.admins === "No one is an admin everywhere yet. For ops, <@U_ANA> is an admin.", `§1 the roster says no one is an admin everywhere, and names the room's admin (saw: ${a.admins})`);
  ok(!/No admins are set up yet/.test(a.you + a.admins), "§1 \"No admins are set up yet\" is never said beside a room admin");
}
{
  const facts: AgentSetupFacts = { ...base, asker: "U_ME", standing: { kind: "member" }, orgAdmins: [], domainAdminsExist: true };
  const a = render("dm, team admins elsewhere", facts);
  ok(!/no admins are set up yet/i.test(a.you + " " + a.admins), `§1 🔴 with team admins elsewhere, no read says "no admins are set up yet" (saw: ${a.you} | ${a.admins})`);
  ok(a.you === "You're not an admin here. No one is an admin everywhere yet." && a.admins === "No one is an admin everywhere yet. Some teams have their own admins.", "§1 the DM read says no one is an admin everywhere, and that teams have their own");
  ok(!/no admins are set up yet/i.test(renderSeatSetupSection(facts)), "§1 🔴 the seat block says the same");
  ok(renderSeatSetupSection(facts).includes("No one is an admin everywhere yet. Some teams have their own admins."), "§1 the seat block says no one is an admin everywhere, and that teams have their own");
}
{
  const a = render("asker cannot be verified", { ...base, standing: { kind: "unknown" } });
  ok(/I can't tell who sent this message/.test(a.you) && !/not an admin/.test(a.you), "§1 🔴 an unverifiable asker reads \"I can't tell\", never \"not an admin\"");
  ok(a.notYet.length === 0, "§1 an unverifiable asker reads no admin-only detail");
}
{
  const a = render("cross-platform roster", {
    ...base,
    standing: { kind: "member" },
    orgAdmins: ["slack/T1/U_ANA", "discord/300000000000000104", "discord/300000000000000105"],
  });
  ok(a.you === "You're not an admin. <@U_ANA> and 2 people on Discord are.", `§1 an admin on another platform is counted, never shown as an id (saw: ${a.you})`);
}

{
  const a = render("test mode", { ...base, github: { mode: "app", appConfigured: true, appSlug: "acme-oe", tokenSet: false }, configChanges: { ...READY, appInstalled: "yes", dryRun: true } });
  ok(a.notYet.length === 1 && /in test mode/.test(a.notYet[0]!.what), "§1 🔴 test mode is a gap");
  ok(!a.adminCanDoNow.some((s) => /pull request/.test(s)), "§1 test mode offers no pull request");
}
{
  const a = render("malformed repo", { ...base, github: { mode: "token", appConfigured: false, tokenSet: true }, configChanges: { repo: "agent-config", adminChannel: true, appInstalled: "unknown" } });
  ok(a.notYet.length === 1 && /owner\/name/.test(a.notYet[0]!.step), "§1 🔴 a malformed repository is a gap");
  ok(!a.adminCanDoNow.some((s) => /pull request/.test(s)), "§1 a malformed repository offers no pull request");
}
{
  const a = render("member, app installed", { ...base, standing: { kind: "member" }, orgAdmins: ["slack/T1/U_ANA"], github: { mode: "app", appConfigured: true, appSlug: "acme-oe", tokenSet: false }, configChanges: { ...READY, appInstalled: "yes" } });
  ok(!personFacing(a).some((s) => /acme/.test(s)), "§1 🔴 a member never reads the repository or its owner, even with the app installed");
}
{
  const a = render("domain admin controls", { ...base, standing: { kind: "domain-admin", domain: "payments" }, roomDomain: { name: "payments", admins: ["slack/T1/U_ME"] }, orgAdmins: ["slack/T1/U_ANA"] });
  ok(a.adminCanDoNow.some((s) => /starting me again needs an org admin/.test(s)) && !a.adminCanDoNow.includes("stop everything I'm doing at once, and start me again"), "§1 🔴 a domain admin is not told they can start me again");
  ok(a.adminCanDoNow.some((s) => /spending limit for one of this domain's rooms/.test(s)), "§1 a domain admin's spending limit is per room");
  const b = render("admin elsewhere", { ...base, standing: { kind: "member" }, adminElsewhere: ["the payments team"], orgAdmins: ["slack/T1/U_ANA"] });
  ok(b.you === "You're not an admin here. You're an admin for the payments team.", `§1 🔴 a domain admin asking elsewhere is not told a bare "not an admin" (saw: ${b.you})`);
}
{
  for (const [name, facts] of branches) {
    const a = renderAgentSetup(facts);
    const allowed = new Set(facts.connectors.map((c) => c.toLowerCase()));
    ok(!personFacing(a).some((s) => /\bnotion\b/i.test(s)) || allowed.has("notion"), `§1 ${name}: names Notion only when the room is connected to it`);
  }
}

for (const [name, facts] of branches) {
  const a = renderAgentSetup(facts);
  for (const s of personFacing(a)) {
    ok(s.trim().length > 0, `§2 ${name}: no blank line`);
    ok(personTextFaults(s).length === 0, `§2 ${name}: passes personTextFaults (saw ${JSON.stringify(personTextFaults(s))} in: ${s})`);
    ok(jargonIn(s).length === 0, `§2 ${name}: carries none of the incident's jargon (saw ${jargonIn(s).join(", ")} in: ${s})`);
    ok(!/memory\/|docs\/|\.md\b|agent\/|\.ts\b/.test(s), `§2 ${name}: names no internal file path (in: ${s})`);
  }
}

for (const before of [
  "Admin standing is a team governance decision.",
  "I can't confirm the runtime-state authority or the capability bindings for this room.",
  "The applicable bundle and the domain declarations carry no live grants here.",
]) {
  ok(jargonIn(before).length > 0, `§3 the jargon check catches the incident's text: ${before}`);
}
ok(personTextFaults("Noted in slack/T0EXAMPLE/C0123ABCD.").length > 0, "§3 the person-text detector catches a raw scope key");

{
  const domains: Domain[] = [
    defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG_ADMIN"] }),
    defineDomain({ name: "txn", title: "the payments team", reach: ["slack/T1/C_TXN"], admins: ["slack/T1/U_TXN_ADMIN"] }),
  ];
  const NO_BASE = { baseBundles: () => [], baseBindings: () => [] };
  let accessRequests: AccessRequestsConfig = { ...NO_BASE };
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadAccessRequests: () => accessRequests,
  });
  clearProviderSelection();
  _resetStatusRegistriesForTest();
  registerSurfaceStatusReporter("slack", async () => ({ installed: "yes" }));
  for (const k of ["OE_GITHUB_APP_ID", "OE_GITHUB_APP_PRIVATE_KEY", "OE_GITHUB_APP_SLUG", "OE_GITHUB_OWNER", "OE_GITHUB_INSTALLATION_ID", "OE_GITHUB_INSTALLATIONS", "GITHUB_TOKEN"]) delete process.env[k];
  resetGitHubApp();

  const ctxFor = (principalId: string, channelId: string): BindableContext => ({
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          principalId,
          principalType: "slack-user",
          attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", is_private: "false" },
        },
      },
    },
  });

  const admin = await gatherAgentSetupFacts(ctxFor("U_ORG_ADMIN", "C_TXN"));
  ok(admin.standing.kind === "org-admin", `§4 🔴 the live standing is resolveRole's: an org admin reads org-admin (saw ${admin.standing.kind})`);
  ok(admin.orgAdmins.length === 1 && admin.orgAdmins[0] === "slack/T1/U_ORG_ADMIN", "§4 the org roster is the registered config's");
  ok(admin.roomDomain?.name === "txn" && admin.roomDomain.admins[0] === "slack/T1/U_TXN_ADMIN", "§4 the room's domain and its admins are read on the same key the gates use");
  ok(admin.domainAdminsExist === true && seatSetupFacts(undefined).domainAdminsExist === true, "§4 🔴 both gathers see that a domain lists admins (the DM seat call included)");
  {
    const txn = domains[1]!;
    domains[1] = defineDomain({ name: "txn", title: "the payments team", reach: ["slack/T1/C_TXN"] });
    const onlyOrg = await gatherAgentSetupFacts(ctxFor("U_RANDOM", "C_TXN"));
    ok(onlyOrg.domainAdminsExist === false && seatSetupFacts(undefined).domainAdminsExist === false, "§4 🔴 negative control: the org list alone does not count as a team's admins");
    domains[1] = txn;
  }
  {
    const org = domains[0]!;
    domains[0] = defineDomain({ name: "org", match: "org", memory: "org-brain" });
    const dm = renderAgentSetup(await gatherAgentSetupFacts(ctxFor("U_RANDOM", "C_NOWHERE")));
    ok(!/no admins are set up yet/i.test(`${dm.you} ${dm.admins}`) && dm.admins === "No one is an admin everywhere yet. Some teams have their own admins.", `§4 🔴 end to end, team admins elsewhere never read as "no admins" (saw: ${dm.you} | ${dm.admins})`);
    domains[0] = org;
  }
  ok(admin.surfaces.length === 1 && admin.surfaces[0]!.platform === "slack" && admin.surfaces[0]!.installed === "yes", "§4 the chat surfaces are the status route's own answer");
  ok(admin.configChanges.repo === undefined && !admin.configChanges.adminChannel, "§4 no config repo is set");

  declareProviderSelection(["slack", "notion", "github"]);
  registerSurfaceStatusReporter("slack", async () => ({ installed: "yes" }));
  const selected = await gatherAgentSetupFacts(ctxFor("U_ORG_ADMIN", "C_TXN"));
  ok(selected.surfaces.map((x) => x.platform).join(",") === "slack", `§4 🔴 only a surface that reports a status is a chat app (saw ${selected.surfaces.map((x) => x.platform).join(",")})`);
  ok(!renderAgentSetup(selected).connectedTo.some((l) => /notion/i.test(l)), "§4 🔴 a selected Notion bundle is never listed as connected");
  clearProviderSelection();
  _resetStatusRegistriesForTest();
  registerSurfaceStatusReporter("slack", async () => ({ installed: "yes" }));

  const member = await gatherAgentSetupFacts(ctxFor("U_RANDOM", "C_TXN"));
  ok(member.standing.kind === "member", "§4 a person on no roster reads member");
  const domainAdmin = await gatherAgentSetupFacts(ctxFor("U_TXN_ADMIN", "C_TXN"));
  ok(domainAdmin.standing.kind === "domain-admin" && domainAdmin.standing.domain === "txn", "§4 a domain admin reads domain-admin for this room's domain");
  const elsewhere = await gatherAgentSetupFacts(ctxFor("U_TXN_ADMIN", "C_OTHER"));
  ok(elsewhere.standing.kind === "member" && elsewhere.adminElsewhere?.[0] === "the payments team", "§4 🔴 a domain admin in another room reads member here and admin for their domain");

  const versionOut = (await agentVersionTool.execute!({}, ctxFor("U_ORG_ADMIN", "C_TXN") as never)) as { version: string; setup?: AgentSetupAnswer };
  ok(typeof versionOut.version === "string", "§4 agent_version still answers its version fields");
  ok(versionOut.setup !== undefined, "§4 🔴 agent_version carries the `setup` read");
  const out = versionOut.setup!;
  ok(out.you === "You're an admin.", `§4 the tool answers an org admin "You're an admin." (saw: ${out.you})`);
  ok(out.admins.startsWith("The admin is you."), `§4 the tool names the asker as the admin (saw: ${out.admins})`);
  ok(out.notYet.some((g) => /Changing my setup from chat is off/.test(g.what)), "§4 the tool names the config-change gap on a deployment with no config repo");

  accessRequests = { ...NO_BASE, configRepo: "acme/agent-config", adminChannel: "C_ADMIN" };
  process.env.OE_GITHUB_APP_ID = "1";
  process.env.OE_GITHUB_APP_PRIVATE_KEY = "unused-by-the-gather";
  process.env.OE_GITHUB_APP_SLUG = "acme-oe";
  process.env.OE_GITHUB_OWNER = "acme";
  process.env.OE_GITHUB_INSTALLATION_ID = "42";
  const ready = await gatherAgentSetupFacts(ctxFor("U_ORG_ADMIN", "C_TXN"));
  ok(ready.github.appConfigured && ready.github.appSlug === "acme-oe", "§4 the GitHub app's identity is read");
  ok(ready.configChanges.repo === "acme/agent-config" && ready.configChanges.adminChannel && ready.configChanges.appInstalled === "yes", "§4 🔴 an installation for the repository's owner reads installed");
  ok(renderAgentSetup(ready).notYet.length === 0, "§4 a ready deployment reads no gap");

  process.env.OE_GITHUB_OWNER = "someone-else";
  const missing = await gatherAgentSetupFacts(ctxFor("U_ORG_ADMIN", "C_TXN"));
  ok(missing.configChanges.appInstalled === "no", `§4 🔴 no installation for the repository's owner reads not installed (saw ${missing.configChanges.appInstalled})`);
  ok(/I can't find it installed for acme/.test(renderAgentSetup(missing).notYet[0]?.what ?? ""), "§4 …and the answer names the missing install");
  const seatMissing = renderSeatSetupSection(seatSetupFacts("txn"));
  ok(/^### Your admins and your setup/.test(seatMissing), "§5 the seat block is headed `### Your admins and your setup`");
  ok(seatMissing.includes("<@U_ORG_ADMIN>, `author-id` U_ORG_ADMIN on Slack"), `§5 🔴 the seat block names each org admin by mention and by the author-id it matches (saw: ${seatMissing})`);
  ok(seatMissing.includes("Admins for the payments team only:") && seatMissing.includes("`author-id` U_TXN_ADMIN on Slack"), "§5 the room's domain admins are listed apart");
  ok(/answer from it in one message/.test(seatMissing) && /never call it a team decision/.test(seatMissing), "§5 the seat is told to answer in one message, never from memory, never as a team decision");
  ok(seatMissing.includes(`- on the "everywhere" list: "You're an admin."`), "§5 🔴 an org admin reads a plain \"You're an admin\"");
  ok(seatMissing.includes(`- on the "the payments team only" list: "You're an admin for the payments team."`), "§5 🔴 a domain admin reads which domain");
  ok(/- anyone else: "You're not an admin here\."/.test(seatMissing) && !/"You're not an admin\."/.test(seatMissing), "§5 🔴 anyone else reads \"not an admin here\", never a bare \"not an admin\"");
  ok(/- no `author-id`, or several people in the one wake: "I can't tell who sent this/.test(seatMissing) && /Never guess "not an admin"/.test(seatMissing), "§5 🔴 an author the seat cannot name reads \"I can't tell\"");
  ok(!/acme/.test(seatMissing), `§5 🔴 the seat block never names the repository or its owner (saw: ${seatMissing})`);
  ok(seatMissing.includes("I can't confirm from here whether the GitHub app is installed on my own repository. A worker checks it with `agent_version`.") && !/Not ready yet/.test(seatMissing), `§5 an unconfirmed install is a neutral line, not a gap (saw: ${seatMissing})`);
  await recordGitHubInstallation({ owner: "acme", installationId: "777", updatedAt: new Date().toISOString() });
  ok(renderSeatSetupSection(seatSetupFacts("txn")) === seatMissing, "§5 🔴 a webhook-recorded installation does not move the seat block's bytes");
  process.env.OE_GITHUB_OWNER = "acme";
  const seatReady = renderSeatSetupSection(seatSetupFacts("txn"));
  ok(/Changing your setup from chat is ready\./.test(seatReady) && seatReady.includes("pull request on your own repository") && !/acme/.test(seatReady), `§5 🔴 an env-installed app reads ready in the seat block, with no repository name (saw: ${seatReady})`);
  ok(!/Not ready yet/.test(seatReady), "§5 a ready deployment shows no gap to the seat");

  const prompt1 = await renderScopeMarkdown(ctxFor("U_RANDOM", "C_TXN"));
  const prompt2 = await renderScopeMarkdown(ctxFor("U_ORG_ADMIN", "C_TXN"));
  ok(prompt1.includes("### Your admins and your setup") && prompt1.includes("`author-id` U_ORG_ADMIN on Slack"), "§5 🔴 the seat prompt carries the admins-and-setup block");
  ok(prompt1 === prompt2, "§5 the block does not depend on who sent the message, so the prompt is byte-stable across askers");

  for (const k of ["OE_GITHUB_APP_ID", "OE_GITHUB_APP_PRIVATE_KEY", "OE_GITHUB_APP_SLUG", "OE_GITHUB_OWNER", "OE_GITHUB_INSTALLATION_ID"]) delete process.env[k];
  _resetStatusRegistriesForTest();
}

ok(LEAN_SEAT_TOOLS.size === 18 && !LEAN_SEAT_TOOLS.has("agent_setup"), "§5 🔴 the seat roster stays at 18 verbs");
{
  const noGithub = renderSeatSetupSection({ ...base, configChanges: { ...READY, appInstalled: "no" } });
  ok(/Not ready yet: .*The one step: Whoever runs this deployment sets up the GitHub app and installs it on my own repository\./.test(noGithub) && !/acme/.test(noGithub), `§5 🔴 a gap in the seat block names no repository (saw: ${noGithub})`);
  const roomOnly = renderSeatSetupSection({ ...base, orgAdmins: [], roomDomain: { name: "ops", title: "ops", admins: ["slack/T1/U_ANA"] } });
  ok(roomOnly.includes("No one is an admin everywhere yet.") && !/No admins are set up yet/.test(roomOnly), `§5 🔴 the seat block with room admins only never says "No admins are set up yet" (saw: ${roomOnly})`);
  ok(!roomOnly.includes(`"everywhere" list`) && roomOnly.includes(`- on the "ops only" list: "You're an admin for ops."`), "§5 the seat block has no rule for an empty everywhere list");
  const shortRepo = renderSeatSetupSection({ ...base, configChanges: { repo: "oe", adminChannel: true, appInstalled: "unknown" } });
  ok(shortRepo.includes("Whoever runs this deployment sets my own repository as owner/name, then deploys."), `§5 🔴 a malformed repository setting reads whole (saw: ${shortRepo})`);
  const empty = renderSeatSetupSection({ ...base, orgAdmins: [] });
  ok(empty.includes("No admins are set up yet. Whoever runs this deployment adds the first one."), "§5 a fresh install's seat block says no admins are set up yet");
  ok(/Not ready yet: Changing my setup from chat is off\./.test(empty), "§5 a fresh install's seat block says config changes from chat are off");
  const v = REPLY_STYLE_RUBRIC.replace(/\s+/g, " ");
  ok(/One answer is one message/.test(v) && /"I'll check that"/.test(v), "§5 the voice section forbids the preamble post");
  ok(/never a path to a file of your own or of the manual/.test(v), "§5 the voice section forbids a path as a citation");
  ok(/when it bears on the answer/.test(v), "§5 the voice section keeps an unasked-about service out of the answer");
  ok(/never from memory, the/.test(v) && /a worker reads the rest with `agent_version`/.test(v) && /As a conversation's seat/.test(v), "§5 the voice section sends a question about the agent itself to its live setup");
}

{
  registerDocs([{ path: "docs/glossary.md", title: "Glossary", summary: "S", markdown: "# Glossary\n" }]);
  const out = (await readDocsTool.execute!({ path: "docs/glossary.md" }, {} as never)) as { path?: string; url?: string };
  ok(out.path === "docs/glossary.md" && out.url === docUrl("docs/glossary.md") && out.url.startsWith("https://"), `§6 🔴 read_docs returns the doc's public url (saw ${out.url})`);
}

console.log(`agent-setup-test: ${n} assertions passed`);
