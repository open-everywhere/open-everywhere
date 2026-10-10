_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}

import {
  resolveWakeTrustFromContext,
  registerIdentityMapper,
  defineDomain,
  type Domain,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { slackChannelWatchWake, slackThreadFollowWake, slackNameDropWake, renderNameDropMessage, type ParsedMessageEvent } from "../agent/channels/slack-events.js";
import { _resetDeploymentIdentityForTest, type NormalizedWake } from "@open-everywhere/core/agent/adapter-api.js";

registerIdentityMapper("slack", bindSlack);

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ORG_ADMIN"] }),
  defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"], admins: ["slack/T1/U_ENG_ADMIN"] }),
];

function slackCtx(attributes: Record<string, string>): BindableContext {
  return { channel: { kind: "slack" }, session: { auth: { current: { attributes, principalId: "", principalType: "slack-user" } } } };
}
const VERIFIED = { team_id: "T1", channel_id: "C_ENG", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" };

ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "principal", "ctx form: verified-internal Slack channel + org admin (human) → principal");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ENG_ADMIN", isBot: false }, { domains: DOMAINS }) === "principal", "ctx form: domain admin on the domain's channel (binding-derived channelKey) → principal");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_MEMBER", isBot: false }, { domains: DOMAINS }) === "peer", "ctx form: verified-internal member → peer");
ok(resolveWakeTrustFromContext(slackCtx({ team_id: "T1", channel_id: "C_ENG", channel_type: "channel" }), { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "unauth", "ctx form: trust never checked → the binding fails closed → a HUMAN admin is unauth (unvouched surface), never up");
ok(resolveWakeTrustFromContext(slackCtx({ ...VERIFIED, is_ext_shared: "true" }), { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "unauth", "ctx form: externally-shared channel → a human is unauth (unvouched)");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ORG_ADMIN", isBot: true }, { domains: DOMAINS }) === "relay", "ctx form: explicit bot author → relay (machine floor)");
ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { isBot: false }, { domains: [] }) === "unauth", "ctx form: a HUMAN with no author id anywhere → unauth (unidentifiable human, fail closed down)");

ok(resolveWakeTrustFromContext(slackCtx(VERIFIED), { id: "U_ORG_ADMIN" }, { domains: DOMAINS }) === "relay", "ctx form: unknown bot-ness (isBot undefined) fails closed → relay, even for a rostered admin");

const adminPrincipalCtx = slackCtx({ ...VERIFIED, user_id: "U_ORG_ADMIN" });
ok(resolveWakeTrustFromContext(adminPrincipalCtx, { isBot: false }, { principalFallback: true, domains: DOMAINS }) === "principal", "ctx form: a TRIGGER (principalFallback on) with no explicit author id borrows the bound admin principal → principal");
ok(resolveWakeTrustFromContext(adminPrincipalCtx, { isBot: false }, { domains: DOMAINS }) === "unauth", "ctx form: a SIBLING (no fallback) HUMAN with no author id does NOT borrow the principal → unauth, never the trigger author's principal tier (the notion-sibling escalation fix — floor is now the unvouched-human unauth, still below peer)");

const ev: ParsedMessageEvent = {
  channelId: "C_ENG", teamId: "T1", ts: "1752501000.000100", threadTs: undefined,
  text: "morning all", userId: "U_MEMBER", botId: undefined, subtype: undefined,
  isAppMention: false, channelType: "channel", previousText: undefined, attachments: [],
} as unknown as ParsedMessageEvent;
const triggerTrust = (w: NormalizedWake): string | undefined => (w.trigger.kind === "message" ? w.trigger.message.trust : undefined);
ok(triggerTrust(slackChannelWatchWake(ev, { trust: "principal" })) === "principal", "slack supervisor builder: opts.trust rides into the trigger");
function __ope596SlackPins(): void {
  void slackChannelWatchWake(ev);
  void slackChannelWatchWake(ev, { memberCount: 3 });
  void slackNameDropWake(ev, "Open Everywhere");
  void renderNameDropMessage(ev, "Open Everywhere");
}
void __ope596SlackPins;
ok(triggerTrust(slackChannelWatchWake(ev, { trust: "unauth" })) === "unauth", "slack supervisor builder: a fail-closed tier rides in unchanged — nothing talks it up");
ok(triggerTrust(slackThreadFollowWake(ev, { trust: "relay" })) === "relay", "slack thread-follow builder: opts.trust rides into the trigger");
ok(triggerTrust(slackNameDropWake(ev, "Open Everywhere", { trust: "unauth" })) === "unauth", "slack name-drop builder: a fail-closed tier rides in unchanged");


console.log(`slack-wake-trust tests passed (${passed})`);
