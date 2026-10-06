// proves: SEAT-62

import assert from "node:assert/strict";
import { sourcesForWindow, windowSourcesNeedConfig, encodeSources, decodeSources } from "../agent/channels/window-sources.js";
import { dmAnchorDomain, taskWindowId } from "../agent/channels/window-key.js";
import { defineDomain } from "../agent/memory/domain.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SLACK_A = "slack/T_ENG/C_TXN";
const SLACK_B = "slack/T_ENG/C_TXN_EMEA";
const GH = "github/acme/payments-api";
const LINEAR = "linear/O_ACME/T_PAY";
const NOTION = "notion/W_ACME/P_PAY";
const DISCORD = "discord/G_ACME/CH_PAY";
const TEAMS = "teams/TEN_ACME/19-pay.tacv2";
const payments = defineDomain({
  name: "payments",
  reach: [SLACK_A, SLACK_B, GH, LINEAR, NOTION, DISCORD, TEAMS],
  ambientSupervisor: true,
  mode: "unified",
});
const soloDomain = defineDomain({ name: "hr", reach: ["slack/T_ENG/C_HR"], ambientSupervisor: true });
const domains = [payments, soloDomain];

eq(
  sourcesForWindow("payments", "payments", domains),
  ["slack", "github", "linear", "notion", "discord", "teams"],
  "multi-source window (windowId===domain): the distinct platform prefixes of the domain's channels, in channel order",
);
const paymentsSources = sourcesForWindow("payments", "payments", domains);
eq(paymentsSources.filter((p) => p === "slack").length, 1, "dedupe: two slack channels yield exactly ONE 'slack' source");

eq(sourcesForWindow("hr", "hr", domains), ["slack"], "a single-channel domain's window has one source (multi form collapses to solo)");

eq(sourcesForWindow("nope", "nope", domains), [], "unknown domain → empty vector (carriage fails it closed to the single origin)");

eq(sourcesForWindow("slack/T_ENG/C_TXN", "payments", domains), ["slack"], "solo window (surface-key windowId): the single platform prefix");
eq(sourcesForWindow("github/acme/payments-api", "payments", domains), ["github"], "solo window: a GitHub surface key → ['github']");

const slackTask = taskWindowId("slack/T_ENG/C_TXN", "1720000000.001");
eq(sourcesForWindow(slackTask, "payments", []), ["slack"], "task child inherits the parent-origin platform (slack) — with NO config, proving the task branch is config-free");
const ghTask = taskWindowId("github/acme/payments-api", "42");
eq(sourcesForWindow(ghTask, "payments", []), ["github"], "task child on a GitHub thread inherits ['github']");
const discordTask = taskWindowId("discord/G_ACME/CH_PAY", "990");
eq(sourcesForWindow(discordTask, "payments", []), ["discord"], "task child on a Discord thread inherits ['discord'] (channelKey's FIRST segment is the platform)");

const DM_SURFACE = "slack/T_ENG/D999";
const dmDomain = dmAnchorDomain(DM_SURFACE);
eq(sourcesForWindow(dmDomain, dmDomain, []), ["slack"], "DM SEAT window (degenerate on the pseudo-domain) → the DM's own platform, with NO config load");
eq(sourcesForWindow(dmDomain, dmDomain, domains), ["slack"], "…and the answer does not depend on the domain roster (a DM surface is in none of them)");
const teamsDm = dmAnchorDomain("teams/TEN_ACME/19-dm.tacv2");
eq(sourcesForWindow(teamsDm, teamsDm, []), ["teams"], "the arm is platform-agnostic — a Teams DM window resolves ['teams']");
const dmTask = taskWindowId("slack/T_ENG/D999", "D999", "nonce1");
eq(sourcesForWindow(dmTask, dmDomain, []), ["slack"], "a DM-ANCHORED WORKER still resolves through the TASK arm (windowId's channelKey), untouched by the new anchor arm");
eq(sourcesForWindow("s/slack/T_ENG/D999/1720000000.001", dmDomain, []), ["slack"], "a DM-anchored thread seat resolves the DM's platform (not the 's' grain marker)");

const CHATTER_A = "slack/T_ENG/C_CHATTER";
const CHATTER_B = "discord/G_ACME/CH_CHATTER";
const ALONE = "slack/T_ENG/C_ALONE";
const grouped = defineDomain({
  name: "chatter-dom",
  reach: [CHATTER_A, CHATTER_B, ALONE, GH, "github/acme-ships/*"],
  ambientSupervisor: true,
  windows: [
    { name: "chatter", reach: [CHATTER_A, CHATTER_B] },
    { name: "shipping", reach: ["github/acme-ships/*"] },
  ],
});
const groupedDomains = [payments, soloDomain, grouped];

eq(
  sourcesForWindow("chatter", "chatter-dom", groupedDomains),
  ["slack", "discord"],
  "named group window: the DISTINCT platforms of THAT group's members, in declaration order",
);
assert.ok(
  !sourcesForWindow("chatter", "chatter-dom", groupedDomains).includes("chatter"),
  "PHANTOM GUARD: a group window NEVER reports its own name as a platform (the solo fallback's platformOf would)",
);
n++;
eq(
  sourcesForWindow("chatter", "chatter-dom", groupedDomains).length,
  2,
  "…and it reports exactly the group's two platforms, not the whole domain's three",
);
eq(sourcesForWindow("shipping", "chatter-dom", groupedDomains), [], "a CLAIM-only group yields the empty vector — claims are no more enumerable here than at the domain grain");
eq(
  sourcesForWindow("claim-only-dom", "claim-only-dom", [defineDomain({ name: "claim-only-dom", reach: ["github/acme-ships"], ambientSupervisor: true })]),
  [],
  "…and a claim-only DOMAIN's own window is empty for the same reason",
);
eq(sourcesForWindow("no-such-group", "chatter-dom", groupedDomains), [], "an undeclared slash-free windowId yields EMPTY (carriage fails it closed), never a phantom platform");
eq(sourcesForWindow("chatter", "no-such-domain", groupedDomains), [], "a group name under an unknown domain yields EMPTY");
eq(
  sourcesForWindow("chatter-dom", "chatter-dom", groupedDomains),
  ["slack", "discord", "github"],
  "the degenerate id-equals-domain arm is still checked FIRST on a grouped domain",
);
eq(sourcesForWindow(ALONE, "chatter-dom", groupedDomains), ["slack"], "a solo (surface-key) window in a grouped domain is unchanged");

ok(windowSourcesNeedConfig("payments", "payments"), "needs config: the degenerate id-equals-domain window reads the domain's channels");
ok(windowSourcesNeedConfig("chatter", "chatter-dom"), "needs config: a NAMED GROUP (slash-free windowId) reads the group's members");
ok(!windowSourcesNeedConfig(SLACK_A, "payments"), "identity-only: a solo surface-key window carries its platform in the id");
ok(!windowSourcesNeedConfig(slackTask, "payments"), "identity-only: a task child reads its platform off the task windowId");
ok(!windowSourcesNeedConfig(dmDomain, dmDomain), "identity-only: a DM anchor derives from the pseudo-domain");
ok(!windowSourcesNeedConfig("s/slack/T_ENG/D999/1720000000.001", dmDomain), "identity-only: a thread seat is slash-bearing and DM-anchored");
for (const [windowId, dom, expected] of [
  [SLACK_A, "payments", ["slack"]],
  [slackTask, "payments", ["slack"]],
  [dmDomain, dmDomain, ["slack"]],
  ["s/slack/T_ENG/D999/1720000000.001", dmDomain, ["slack"]],
] as const) {
  eq(sourcesForWindow(windowId, dom, []), [...expected], `a shape declared identity-only resolves its real sources with NO config: ${windowId}`);
}

eq(encodeSources(["slack", "github"]), "slack,github", "encodeSources comma-joins the vector");
eq(decodeSources("slack,github"), ["slack", "github"], "decodeSources splits the stamp back to a vector");
eq(decodeSources(encodeSources(paymentsSources)), paymentsSources, "encode→decode round-trips the multi-source vector");
eq(decodeSources(""), [], "decodeSources fails soft on an empty string");
eq(decodeSources(undefined), [], "decodeSources fails soft on a non-string (absent stamp)");
eq(decodeSources("slack, , github ,"), ["slack", "github"], "decodeSources trims and drops blank segments");

eq(
  sourcesForWindow("w/payments", "payments", domains),
  sourcesForWindow("payments", "payments", domains),
  "🔴 a work session's sources ARE its seat's: `w/payments` reads the domain roster, never a phantom platform `w`",
);
ok(!sourcesForWindow("w/payments", "payments", domains).includes("w"), "…and never names the phantom platform `w`");
eq(sourcesForWindow("w/slack/T1/C1", "solo", []), sourcesForWindow("slack/T1/C1", "solo", []), "a solo seat's work session carries the solo seat's one platform");
eq(windowSourcesNeedConfig("w/payments", "payments"), windowSourcesNeedConfig("payments", "payments"), "…and needs the config exactly when its seat does");

console.log(`window-sources-test: ${n} assertions passed`);
