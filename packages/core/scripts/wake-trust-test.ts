for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST"]) {
  delete process.env[k];
}

import {
  wakeTrustFor,
  wakeAuthorIsAdmin,
  resolveWakeTrust,
  loadDomainsForWakeTrust,
  resolveWakeTrustFromContext,
} from "../agent/identity/wake-trust.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { buildGitHubSupervisorWake } from "../agent/channels/github-supervisor.js";
import { buildLinearSupervisorWake } from "../agent/channels/linear-supervisor.js";
import { buildNotionSupervisorWake } from "../agent/channels/notion-supervisor.js";
import { slackChannelWatchWake, slackThreadFollowWake, type ParsedMessageEvent } from "../agent/channels/slack-events.js";
import { clusterBackscroll, type NormalizedMessage } from "../agent/channels/backscroll-cluster.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "org", match: "org", admins: ["U_ORG_ADMIN"] }),
  defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["U_ENG_ADMIN"] }),
];

ok(wakeTrustFor({ authorIsBot: true, authorId: "B1", surfaceInternal: true, authorIsAdmin: true }) === "relay", "bot author → relay, even a rostered one (machine-authored never speaks with standing)");
ok(wakeTrustFor({ authorIsBot: false, authorId: undefined, surfaceInternal: true, authorIsAdmin: false }) === "relay", "unidentifiable author → relay (fail closed)");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: false, authorIsAdmin: false }) === "relay", "external/unverified surface → relay (the existing gate's fail-closed posture)");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: false, authorIsAdmin: true }) === "relay", "an admin on an UNVERIFIED surface is still relay — surface gate first, never up");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: true, authorIsAdmin: false }) === "peer", "identified internal member → peer");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: true, authorIsAdmin: true }) === "principal", "rostered admin on an internal surface → principal");

ok(wakeAuthorIsAdmin("U_ORG_ADMIN", "slack/T1/C_RANDOM", DOMAINS), "org admin is an admin on EVERY channel");
ok(wakeAuthorIsAdmin("U_ORG_ADMIN", undefined, DOMAINS), "org admin resolves even without a channel key");
ok(wakeAuthorIsAdmin("U_ENG_ADMIN", "slack/T1/C_ENG", DOMAINS), "domain admin is an admin on the domain's own channel");
ok(!wakeAuthorIsAdmin("U_ENG_ADMIN", "slack/T1/C_OTHER", DOMAINS), "domain admin is NOT an admin on another channel");
ok(!wakeAuthorIsAdmin("U_ENG_ADMIN", undefined, DOMAINS), "domain admin without a channel key → not an admin (fail closed)");
ok(!wakeAuthorIsAdmin("U_MEMBER", "slack/T1/C_ENG", DOMAINS), "a plain member never resolves admin");
ok(!wakeAuthorIsAdmin(undefined, "slack/T1/C_ENG", DOMAINS), "no author id → not an admin (fail closed)");
ok(!wakeAuthorIsAdmin("U_ORG_ADMIN", "slack/T1/C_ENG", []), "empty rosters → nobody is an admin");

ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "principal", "resolveWakeTrust: org admin on internal channel → principal");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ENG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "principal", "resolveWakeTrust: domain admin on their channel → principal");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ENG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_OTHER", domains: DOMAINS }) === "peer", "resolveWakeTrust: domain admin elsewhere → peer");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_MEMBER", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "peer", "resolveWakeTrust: member → peer");
ok(resolveWakeTrust({ authorIsBot: true, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "relay", "resolveWakeTrust: bot → relay");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ORG_ADMIN", surfaceInternal: false, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "relay", "resolveWakeTrust: unconfirmed surface → relay");

ok(loadDomainsForWakeTrust().length === 0, "unregistered config → empty rosters (fail-closed direction)");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG" }) === "peer", "unregistered config: an internal human is peer, NEVER principal");

function slackCtx(attributes: Record<string, string>): BindableContext {
  return { channel: { kind: "slack" }, session: { auth: { current: { attributes, principalId: "", principalType: "slack-user" } } } };
}
const VERIFIED = { team_id: "T1", channel_id: "C_ENG", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" };

ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "principal", "ctx form: verified-internal Slack channel + org admin (human) → principal");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ENG_ADMIN", isBot: false }, { domains: DOMAINS }) === "principal", "ctx form: domain admin on the domain's channel (binding-derived channelKey) → principal");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_MEMBER", isBot: false }, { domains: DOMAINS }) === "peer", "ctx form: verified-internal member → peer");
ok(resolveWakeTrustFromContext(slackCtx({ team_id: "T1", channel_id: "C_ENG", channel_type: "channel" }), { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "relay", "ctx form: trust never checked → the binding fails closed → relay, even for an admin");
ok(resolveWakeTrustFromContext(slackCtx({ ...VERIFIED, is_ext_shared: "true" }), { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "relay", "ctx form: externally-shared channel → relay");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ORG_ADMIN", isBot: true }, { domains: DOMAINS }) === "relay", "ctx form: explicit bot author → relay");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { isBot: false }, { domains: [] }) === "relay", "ctx form: no author id anywhere → relay (fail closed)");

ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ORG_ADMIN" }, { domains: DOMAINS }) === "relay", "ctx form: unknown bot-ness (isBot undefined) fails closed → relay, even for a rostered admin");

const adminPrincipalCtx = slackCtx({ ...VERIFIED, user_id: "U_ORG_ADMIN" });
ok(resolveWakeTrustFromContext(adminPrincipalCtx, { isBot: false }, { principalFallback: true, domains: DOMAINS }) === "principal", "ctx form: a TRIGGER (principalFallback on) with no explicit author id borrows the bound admin principal → principal");
ok(resolveWakeTrustFromContext(adminPrincipalCtx, { isBot: false }, { domains: DOMAINS }) === "relay", "ctx form: a SIBLING (no fallback) with no author id does NOT borrow the principal → relay (the notion-sibling escalation fix)");

const ghWake = buildGitHubSupervisorWake({
  owner: "acme", repo: "api", issueNumber: 7,
  trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "principal" },
});
ok(ghWake.trigger.kind === "message" && ghWake.trigger.message.trust === "principal", "github builder: a resolved trigger trust rides into the wake");
const ghDefault = buildGitHubSupervisorWake({ owner: "acme", repo: "api", issueNumber: 7, trigger: { id: "c1", authorLogin: "jo", sentAt: "2026-07-11T00:00:00Z", text: "hm" } });
ok(ghDefault.trigger.kind === "message" && ghDefault.trigger.message.trust === "peer", "github builder: unset trust keeps the legacy peer (byte-compat for pure callers)");

const linWake = buildLinearSupervisorWake({
  teamId: "TEAM", issueId: "I1",
  trigger: { id: "c1", authorId: "u1", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "relay" },
});
ok(linWake.trigger.kind === "message" && linWake.trigger.message.trust === "relay", "linear builder: a resolved trigger trust rides into the wake");

const notionWake = buildNotionSupervisorWake({
  addressing: "channel-watch", pageId: "P1", discussionId: "D1",
  trigger: { from: "human", id: "c9", authorId: "n-user", sentAt: "2026-07-11T00:00:00Z", text: "hm", trust: "relay" },
  threadComments: [{ from: "human", id: "c8", authorId: "n-admin", sentAt: "2026-07-11T00:00:00Z", text: "earlier", trust: "principal" }],
});
ok(notionWake.trigger.kind === "message" && notionWake.trigger.message.trust === "relay", "notion builder: resolved trigger trust rides in (direct-addressing no longer implies principal)");
ok(notionWake.backscroll?.[0]?.trust === "principal", "notion builder: resolved sibling trust rides into the backscroll");
const notionDirectDefault = buildNotionSupervisorWake({
  addressing: "direct", pageId: "P1", discussionId: "D1",
  trigger: { from: "human", id: "c9", authorId: "n-user", sentAt: "2026-07-11T00:00:00Z", text: "hm" },
});
ok(notionDirectDefault.trigger.kind === "message" && notionDirectDefault.trigger.message.trust === "principal", "notion builder: unset trust keeps the legacy direct→principal default (pure callers)");

const ev: ParsedMessageEvent = {
  channelId: "C_ENG", teamId: "T1", ts: "1752501000.000100", threadTs: undefined,
  text: "morning all", userId: "U_MEMBER", botId: undefined, subtype: undefined,
  isAppMention: false, channelType: "channel", previousText: undefined, attachments: [],
} as unknown as ParsedMessageEvent;
ok(slackChannelWatchWake(ev, { trust: "principal" }).trigger.message.trust === "principal", "slack supervisor builder: opts.trust rides into the trigger");
ok(slackChannelWatchWake(ev).trigger.message.trust === "peer", "slack supervisor builder: unset trust keeps the legacy peer");
ok(slackThreadFollowWake(ev, { trust: "relay" }).trigger.message.trust === "relay", "slack thread-follow builder: opts.trust rides into the trigger");

const msgs: NormalizedMessage[] = [
  { id: "1", ms: 1000, sender: "human", authorId: "U_ORG_ADMIN", text: "a", type: "channel" },
  { id: "2", ms: 2000, sender: "bot", authorId: "B9", text: "b", type: "channel" },
] as unknown as NormalizedMessage[];
const plain = clusterBackscroll(msgs, 10_000);
ok(plain.every((m) => m.trust === "peer"), "clusterBackscroll without a resolver keeps the legacy peer (goldens byte-identical)");
const resolved = clusterBackscroll(msgs, 10_000, undefined, (m) =>
  m.sender === "human" ? resolveWakeTrust({ authorIsBot: false, authorId: m.authorId, surfaceInternal: true, domains: DOMAINS }) : "relay",
);
ok(resolved.find((m) => m.id === "1")?.trust === "principal", "clusterBackscroll trustFor: a rostered human backscroll author resolves principal");
ok(resolved.find((m) => m.id === "2")?.trust === "relay", "clusterBackscroll trustFor: a bot backscroll author resolves relay");

console.log(`wake-trust tests passed (${passed})`);
