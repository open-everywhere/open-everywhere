for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST", "OE_TEST_DRIVER_IDS"]) {
  delete process.env[k];
}

import {
  wakeTrustFor,
  wakeAuthorIsAdmin,
  resolveWakeTrust,
  loadDomainsForWakeTrust,
  resolveWakeTrustFromContext,
  backscrollTrustResolver,
} from "../agent/identity/wake-trust.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import type { BindableContext } from "../agent/identity/binding.js";
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
  defineDomain({ name: "org", match: "org", admins: ["slack/U_ORG_ADMIN"] }),
  defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["slack/U_ENG_ADMIN"] }),
];

ok(wakeTrustFor({ authorIsBot: true, authorId: "B1", surfaceInternal: true, authorIsAdmin: true }) === "relay", "bot author → relay, even a rostered one (machine-authored never speaks with standing)");
ok(wakeTrustFor({ authorIsBot: false, authorId: undefined, surfaceInternal: true, authorIsAdmin: false }) === "unauth", "unidentifiable HUMAN → unauth (a human but unvouched — below peer, above the machine relay floor)");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: false, authorIsAdmin: false }) === "unauth", "HUMAN on an external/unverified surface → unauth (fail-closed down, not the machine relay floor)");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: false, authorIsAdmin: true }) === "unauth", "a HUMAN admin on an UNVERIFIED surface is still unauth — surface gate first, never up");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: true, authorIsAdmin: false }) === "peer", "identified internal member → peer");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: true, authorIsAdmin: true }) === "principal", "rostered admin on an internal surface → principal");

ok(wakeTrustFor({ authorIsBot: true, authorId: "BDRV", surfaceInternal: true, authorIsAdmin: false, isAllowlistedDriver: true }) === "peer", "allowlisted driver bot → peer (the one relay→peer lift)");
ok(wakeTrustFor({ authorIsBot: true, authorId: "BDRV", surfaceInternal: true, authorIsAdmin: true, isAllowlistedDriver: true }) === "peer", "allowlisted driver bot that is ALSO on an admin roster → STILL peer, NEVER principal (the bot branch returns before the roster check — peer is the hard ceiling)");
ok(wakeTrustFor({ authorIsBot: true, authorId: "BDRV", surfaceInternal: true, authorIsAdmin: false, isAllowlistedDriver: false }) === "relay", "a non-allowlisted bot stays relay (default, byte-identical)");
ok(wakeTrustFor({ authorIsBot: true, authorId: "BDRV", surfaceInternal: true, authorIsAdmin: false }) === "relay", "isAllowlistedDriver unset ⇒ relay (dead code unless the operator opts in)");
ok(wakeTrustFor({ authorIsBot: false, authorId: "U1", surfaceInternal: true, authorIsAdmin: true, isAllowlistedDriver: true }) === "principal", "the lift NEVER touches the human path: a real human admin is still principal even if the flag is (spuriously) set");

ok(wakeAuthorIsAdmin("U_ORG_ADMIN", "slack/T1/C_RANDOM", DOMAINS), "org admin is an admin on EVERY channel");
ok(!wakeAuthorIsAdmin("U_ORG_ADMIN", undefined, DOMAINS), "org admin WITHOUT a channel key → not an admin: the platform half of the roster key is a surface fact, and there is no surface here to read it from (fail closed)");
ok(wakeAuthorIsAdmin("U_ENG_ADMIN", "slack/T1/C_ENG", DOMAINS), "domain admin is an admin on the domain's own channel");
ok(!wakeAuthorIsAdmin("U_ENG_ADMIN", "slack/T1/C_OTHER", DOMAINS), "domain admin is NOT an admin on another channel");
ok(!wakeAuthorIsAdmin("U_ENG_ADMIN", undefined, DOMAINS), "domain admin without a channel key → not an admin (fail closed)");
ok(!wakeAuthorIsAdmin("U_MEMBER", "slack/T1/C_ENG", DOMAINS), "a plain member never resolves admin");
ok(!wakeAuthorIsAdmin(undefined, "slack/T1/C_ENG", DOMAINS), "no author id → not an admin (fail closed)");
ok(!wakeAuthorIsAdmin("U_ORG_ADMIN", "slack/T1/C_ENG", []), "empty rosters → nobody is an admin");

const LS_DOMAINS: readonly Domain[] = [
  defineDomain({ name: "org", match: "org", admins: ["linkSet:set-admin"] }),
  defineDomain({ name: "eng", channels: ["slack/T1/C_ENG"], admins: ["linkSet:set-eng"] }),
];
ok(wakeAuthorIsAdmin("U_X", "slack/T1/C_RANDOM", LS_DOMAINS, ["set-admin"]), "a link-set ORG admin: the author whose confirmed set is the referenced one is an admin everywhere");
ok(!wakeAuthorIsAdmin("U_X", "slack/T1/C_RANDOM", LS_DOMAINS, []), "🔴 no precomputed link-set membership (the sync/fail-closed default) → a link-set admin entry admits NOBODY");
ok(!wakeAuthorIsAdmin("U_X", "slack/T1/C_RANDOM", LS_DOMAINS, ["set-other"]), "a DIFFERENT link-set membership does not match the referenced set");
ok(wakeAuthorIsAdmin("U_X", "slack/T1/C_ENG", LS_DOMAINS, ["set-eng"]), "a link-set DOMAIN admin holds on the domain's own channel");
ok(!wakeAuthorIsAdmin("U_X", "slack/T1/C_OTHER", LS_DOMAINS, ["set-eng"]), "a link-set domain admin is NOT an admin on another channel");
ok(wakeAuthorIsAdmin("U_ORG_ADMIN", "slack/T1/C_ENG", DOMAINS, ["set-admin"]), "a principal-key entry still matches even when a link-set value is also supplied");

const COLLIDING: readonly Domain[] = [
  defineDomain({ name: "org", match: "org", admins: ["discord/300000000000000104"] }),
  defineDomain({ name: "tm", channels: ["teams/W1/C_TM"], admins: ["teams/900900900"] }),
];
ok(wakeAuthorIsAdmin("300000000000000104", "discord/G1/C_ANY", COLLIDING), "the digit-string id IS an org admin on discord, its own namespace");
ok(!wakeAuthorIsAdmin("300000000000000104", "teams/W1/C_TM", COLLIDING), "🔴 …and the SAME digits on teams are NOT — a bare-id roster would have granted a stranger principal-tier standing");
ok(wakeAuthorIsAdmin("900900900", "teams/W1/C_TM", COLLIDING), "the teams domain admin matches on the teams surface");
ok(!wakeAuthorIsAdmin("900900900", "discord/G1/C_ANY", COLLIDING), "…and not on a discord surface, even though nothing but the platform distinguishes the two ids");

ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "principal", "resolveWakeTrust: org admin on internal channel → principal");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ENG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "principal", "resolveWakeTrust: domain admin on their channel → principal");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ENG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_OTHER", domains: DOMAINS }) === "peer", "resolveWakeTrust: domain admin elsewhere → peer");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_MEMBER", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "peer", "resolveWakeTrust: member → peer");
ok(resolveWakeTrust({ authorIsBot: true, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "relay", "resolveWakeTrust: bot → relay (machine floor)");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ORG_ADMIN", surfaceInternal: false, channelKey: "slack/T1/C_ENG", domains: DOMAINS }) === "unauth", "resolveWakeTrust: human admin on an unconfirmed surface → unauth (unvouched, not the machine floor)");

ok(loadDomainsForWakeTrust().length === 0, "unregistered config → empty rosters (fail-closed direction)");
ok(resolveWakeTrust({ authorIsBot: false, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG" }) === "peer", "unregistered config: an internal human is peer, NEVER principal");

const DISCORD_DRIVERS = new Set<string>(["G_GUILD:B_DRV"]);
ok(resolveWakeTrust({ authorIsBot: true, authorId: "B_DRV", surfaceInternal: false, channelKey: "discord/G_GUILD/C_CHAN", driverAllowlist: DISCORD_DRIVERS }) === "peer", "seam: an allowlisted Discord driver bot (guildId:botUserId matched off channelKey workspace) → peer, not relay");
ok(resolveWakeTrust({ authorIsBot: true, authorId: "B_OTHER", surfaceInternal: false, channelKey: "discord/G_GUILD/C_CHAN", driverAllowlist: DISCORD_DRIVERS }) === "relay", "seam: a NON-allowlisted bot in the same guild → relay (exact pair match, no widening)");
ok(resolveWakeTrust({ authorIsBot: true, authorId: "B_DRV", surfaceInternal: false, channelKey: "discord/G_WRONG/C_CHAN", driverAllowlist: DISCORD_DRIVERS }) === "relay", "seam: the right driver bot in the WRONG guild → relay (workspace pin holds through the channelKey)");
ok(resolveWakeTrust({ authorIsBot: true, authorId: "U_ORG_ADMIN", surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS, driverAllowlist: new Set(["T1:U_ORG_ADMIN"]) }) === "peer", "seam: an allowlisted driver whose id is ALSO an org admin → STILL peer, NEVER principal (ceiling holds at the seam too)");
ok(resolveWakeTrust({ authorIsBot: true, authorId: "B_DRV", surfaceInternal: false, channelKey: "discord/G_GUILD/C_CHAN" }) === "relay", "seam: no injected allowlist + empty env (the default) → relay, byte-identical to before the carve-out");

{
  const bare: BindableContext = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C_ENG", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" }, principalId: "", principalType: "slack-user" } } } };
  ok(resolveWakeTrustFromContext(bare, { id: "U_ORG_ADMIN", isBot: false }, { domains: DOMAINS }) === "unauth", "ctx form UNREGISTERED slack mapper: fail-closed to unauth even for a rostered admin");
}

const msgs: NormalizedMessage[] = [
  { id: "1", ms: 1000, sender: "human", authorId: "U_ORG_ADMIN", text: "a", type: "channel" },
  { id: "2", ms: 2000, sender: "bot", authorId: "B9", text: "b", type: "channel" },
  { id: "3", ms: 3000, sender: "human", authorId: "U_STRANGER", text: "c", type: "channel" },
  { id: "4", ms: 4000, sender: "self", authorId: undefined, text: "d", type: "channel" },
] as unknown as NormalizedMessage[];

const plain = clusterBackscroll(msgs, 10_000);
ok(plain.find((m) => m.id === "1")?.trust === "unauth" && plain.find((m) => m.id === "3")?.trust === "unauth", "clusterBackscroll without a resolver: human authors fail closed to unauth (never peer)");
ok(plain.find((m) => m.id === "2")?.trust === "relay" && plain.find((m) => m.id === "4")?.trust === "relay", "clusterBackscroll without a resolver: self + foreign-bot machine authors → relay");

const resolved = clusterBackscroll(msgs, 10_000, undefined, backscrollTrustResolver({ surfaceInternal: true, channelKey: "slack/T1/C_ENG", domains: DOMAINS }));
ok(resolved.find((m) => m.id === "1")?.trust === "principal", "backscrollTrustResolver: a rostered admin backscroll author resolves principal");
ok(resolved.find((m) => m.id === "2")?.trust === "relay", "backscrollTrustResolver: a foreign-bot author resolves relay");
ok(resolved.find((m) => m.id === "3")?.trust === "peer", "backscrollTrustResolver: an identified internal human member resolves peer");
ok(resolved.find((m) => m.id === "4")?.trust === "relay", "backscrollTrustResolver: the bot's OWN (self) post resolves relay — our own words are the machine floor, never misread as unauth");

const unvouched = clusterBackscroll(msgs, 10_000, undefined, backscrollTrustResolver({ surfaceInternal: false, channelKey: "slack/T1/C_ENG", domains: DOMAINS }));
ok(unvouched.find((m) => m.id === "1")?.trust === "unauth" && unvouched.find((m) => m.id === "3")?.trust === "unauth", "backscrollTrustResolver on an unvouched surface: identified human authors → unauth (unvouched, not peer)");
ok(unvouched.find((m) => m.id === "2")?.trust === "relay" && unvouched.find((m) => m.id === "4")?.trust === "relay", "backscrollTrustResolver on an unvouched surface: machine authors (bot/self) still relay");

console.log(`wake-trust tests passed (${passed})`);
