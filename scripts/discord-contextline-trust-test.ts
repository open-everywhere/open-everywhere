import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { parseRelayPayload, authForRelayMessage } from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { gradeDiscordContextLines, type DiscordRoleProbe } from "@open-everywhere/provider-discord/agent/channels/discord-backscroll.js";
import {
  chatWakeIngestsNonMember,
  contextLineIngestion,
  registerAuthorTrust,
  defineAuthorTrust,
  _resetAuthorTrustForTest,
  type ContextLine,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const GUILD = "1300000000000000100";
const TENANT = `discord/${GUILD}`;
const relayEnvelope = (m: Record<string, unknown>) => ({ source: "discord-gateway-relay", message: m });

function ctxForGuild(): BindableContext {
  const parsed = parseRelayPayload(relayEnvelope({ id: "m0", content: "hi", channelId: "C1", guildId: GUILD, author: { id: "U_TRIGGER", bot: false } }));
  const a = authForRelayMessage(parsed!)!;
  return { channel: { kind: "discord" }, session: { auth: { current: a as unknown as { attributes?: Record<string, string> } } } };
}

const line = (senderType: ContextLine["senderType"], senderId: string | undefined, text: string, ts: string): ContextLine => ({
  senderType,
  senderId,
  ts,
  text,
});

function fakeRoleProbe(byAuthor: Record<string, readonly string[] | undefined>, calls?: { n: number }): DiscordRoleProbe {
  return async (_guildId, userId) => {
    if (calls) calls.n += 1;
    return userId in byAuthor ? byAuthor[userId] : undefined;
  };
}

const ctx = ctxForGuild();
const lines = [
  line("user", "U_ALICE", "hydrated backscroll from a guild member", "1"),
  line("agent", undefined, "my own prior reply", "2"),
  line("bot", "B1", "a foreign bot's message", "3"),
  line("unknown", undefined, "an unattributable message", "4"),
];

console.log("1-2. gradeDiscordContextLines (per-line trust):");

const gradedUnvouched = await gradeDiscordContextLines(lines, ctx, GUILD, fakeRoleProbe({}));
ok(gradedUnvouched[1].trust === undefined, "negative control: the agent's OWN line is never graded");
ok(gradedUnvouched[2].trust === undefined, "negative control: a foreign bot's line is never graded");
ok(gradedUnvouched[3].trust === undefined, "negative control: an unattributable line is never graded (no senderId)");
ok(
  gradedUnvouched[0].trust === "unauth",
  "🔴 an UNVOUCHED guild (no OE_TRUST/vouch armed) resolves a human sibling `unauth` — the SAME floor the trigger already sits on for an unvouched guild, not a new behaviour this fix introduces",
);

process.env.OE_TRUST = "internal";
try {
  const gradedVouched = await gradeDiscordContextLines(lines, ctx, GUILD, fakeRoleProbe({}));
  ok(gradedVouched[0].trust === "peer", "a VOUCHED guild resolves a human sibling `peer` — mirrors the trigger's own resolveWakeTrustFromContext exactly");
} finally {
  delete process.env.OE_TRUST;
}

console.log("3. the cost gate on an unarmed tenant:");

{
  const calls = { n: 0 };
  const probe = fakeRoleProbe({ U_ALICE: ["SOME_ROLE"] }, calls);
  const graded = await gradeDiscordContextLines(lines, ctx, GUILD, probe);
  ok(calls.n === 0, "🔴 UNARMED TENANT: the role probe is never called — zero new I/O on the default posture");
  ok(graded[0].authorTrust === undefined, "🔴 UNARMED TENANT: no authorTrust is built for ANY line, even a human one — nothing worth a fetch");
}

const noGuild = await gradeDiscordContextLines(lines, ctx, undefined, fakeRoleProbe({ U_ALICE: [] }));
ok(noGuild[0].authorTrust === undefined, "negative control: no guild id ⇒ no tenant to arm ⇒ no authorTrust");

console.log("4. real role evidence on an armed tenant:");

try {
  registerAuthorTrust([defineAuthorTrust({ tenant: TENANT, internal: [`discord/U_ALICE`] })]);

  const calls = { n: 0 };
  const probe = fakeRoleProbe({ U_ALICE: ["ROLE_STAFF", "ROLE_ONCALL"] }, calls);
  const graded = await gradeDiscordContextLines(
    [line("user", "U_ALICE", "a", "1"), line("user", "U_ALICE", "b", "2"), line("user", "U_BOB", "c", "3")],
    ctx,
    GUILD,
    probe,
  );
  ok(calls.n === 2, "the probe runs once per DISTINCT author (2 for 3 lines: U_ALICE ×2, U_BOB ×1) — a rate-limited API call");
  ok(
    graded[0].authorTrust?.memberships?.length === 2 && graded[0].authorTrust?.memberships?.includes(`${TENANT}/role:ROLE_STAFF`),
    "🔴 memberships carries the REAL roles the probe returned, in the SAME group-rung key shape the trigger's own authorFacts builds — never a hardcoded []",
  );
  ok(graded[0].authorTrust?.tenantKey === TENANT && graded[0].authorTrust?.authorId === "U_ALICE", "the query is keyed on the GUILD, carrying the raw author id");
} finally {
  _resetAuthorTrustForTest();
}

const noSenderId = await gradeDiscordContextLines([line("user", undefined, "no id", "9")], ctx, GUILD, fakeRoleProbe({}));
ok(noSenderId[0].authorTrust === undefined, "negative control: a `user` line with no senderId carries no authorTrust either (nothing to probe)");

console.log("5. role-armed guild: a roled colleague does not mark, an unroled stranger does:");

try {
  registerAuthorTrust([defineAuthorTrust({ tenant: TENANT, internal: [{ membership: `${TENANT}/role:ROLE_STAFF` }] })]);

  const roleArmedLines = [
    line("user", "U_STAFF", "a roled colleague's earlier message", "1"),
    line("user", "U_STRANGER", "an unroled stranger's earlier message", "2"),
  ];
  const graded = await gradeDiscordContextLines(
    roleArmedLines,
    ctx,
    GUILD,
    fakeRoleProbe({ U_STAFF: ["ROLE_STAFF"], U_STRANGER: [] }),
  );
  const ingested = graded.map(contextLineIngestion);

  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }, ingested[0]], {}) === false,
    "🔴 THE BUG THIS FIX CLOSES: a MEMBER's trigger whose backscroll hydrates a ROLED COLLEAGUE's earlier message does NOT mark — the role evidence is real, not an unchecked `[]` that would have made every colleague look external",
  );
  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }, ingested[1]], {}) === true,
    "negative control: the SAME wake, over the UNROLED stranger's message instead, DOES mark — the register still catches a genuine outsider",
  );
} finally {
  _resetAuthorTrustForTest();
}

console.log("6. fail-open on an unresolvable probe:");

try {
  registerAuthorTrust([defineAuthorTrust({ tenant: TENANT, internal: [`discord/U_SOMEONE_ELSE`] })]);

  const unresolvable = await gradeDiscordContextLines([line("user", "U_UNKNOWN_TO_THE_PROBE", "hi", "1")], ctx, GUILD, fakeRoleProbe({}));
  ok(unresolvable[0].authorTrust === undefined, "🔴 a probe that cannot answer (not in the table, i.e. undefined) leaves NO authorTrust on the line — SKIPPED, never an unverified []");
  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }, contextLineIngestion(unresolvable[0])], {}) === false,
    "…so the join does not mark from a fetch that never resolved — 'cannot check' is not 'checked and refuted'",
  );

  const verifiedNonMember = await gradeDiscordContextLines([line("user", "U_LEFT_THE_GUILD", "hi", "1")], ctx, GUILD, fakeRoleProbe({ U_LEFT_THE_GUILD: [] }));
  ok(verifiedNonMember[0].authorTrust?.memberships?.length === 0, "negative control: a VERIFIED empty roles array (the probe's own 404 case) DOES build an authorTrust — it is real evidence, not a guess");
} finally {
  _resetAuthorTrustForTest();
}

console.log("7. contextLineIngestion:");

try {
  registerAuthorTrust([defineAuthorTrust({ tenant: TENANT, internal: [`discord/U_SOMEONE_ELSE`] })]);
  const graded = await gradeDiscordContextLines([line("user", "U_ALICE", "hi", "1")], ctx, GUILD, fakeRoleProbe({ U_ALICE: [] }));
  const ingested = contextLineIngestion(graded[0]);
  ok(ingested.authorTrust?.authorId === "U_ALICE", "contextLineIngestion carries authorTrust through unmodified");
  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }, ingested], {}) === true,
    "🔴 ARMED, AUTHOR NOT DECLARED: a MEMBER's trigger whose backscroll hydrates an UNDECLARED guild author's earlier message marks the wake",
  );
} finally {
  _resetAuthorTrustForTest();
}

console.log(`\n✅ discord contextline trust: ${passed} assertions passed`);
