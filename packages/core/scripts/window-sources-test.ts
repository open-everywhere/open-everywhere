import assert from "node:assert/strict";
import { sourcesForWindow, encodeSources, decodeSources } from "../agent/channels/window-sources.js";
import { taskWindowId } from "../agent/channels/window-key.js";
import { defineDomain } from "../agent/memory/domain.js";

let n = 0;
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
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
  channels: [SLACK_A, SLACK_B, GH, LINEAR, NOTION, DISCORD, TEAMS],
  ambientSupervisor: true,
  unifiedSupervisor: true,
  crossSurfaceWindow: true,
});
const soloDomain = defineDomain({ name: "hr", channels: ["slack/T_ENG/C_HR"], ambientSupervisor: true });
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

eq(encodeSources(["slack", "github"]), "slack,github", "encodeSources comma-joins the vector");
eq(decodeSources("slack,github"), ["slack", "github"], "decodeSources splits the stamp back to a vector");
eq(decodeSources(encodeSources(paymentsSources)), paymentsSources, "encode→decode round-trips the multi-source vector");
eq(decodeSources(""), [], "decodeSources fails soft on an empty string");
eq(decodeSources(undefined), [], "decodeSources fails soft on a non-string (absent stamp)");
eq(decodeSources("slack, , github ,"), ["slack", "github"], "decodeSources trims and drops blank segments");

console.log(`window-sources-test: ${n} assertions passed`);
