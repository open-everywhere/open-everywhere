import assert from "node:assert/strict";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { parseRelayPayload, authForRelayMessage } from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { gradeDiscordContextLines } from "@open-everywhere/provider-discord/agent/channels/discord-backscroll.js";
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

console.log("1-2. gradeDiscordContextLines (per-line trust):");

const ctx = ctxForGuild();
const lines = [
  line("user", "U_ALICE", "hydrated backscroll from a guild member", "1"),
  line("agent", undefined, "my own prior reply", "2"),
  line("bot", "B1", "a foreign bot's message", "3"),
  line("unknown", undefined, "an unattributable message", "4"),
];

const gradedUnvouched = gradeDiscordContextLines(lines, ctx, GUILD);
ok(gradedUnvouched[1].trust === undefined, "negative control: the agent's OWN line is never graded");
ok(gradedUnvouched[2].trust === undefined, "negative control: a foreign bot's line is never graded");
ok(gradedUnvouched[3].trust === undefined, "negative control: an unattributable line is never graded (no senderId)");
ok(
  gradedUnvouched[0].trust === "unauth",
  "🔴 an UNVOUCHED guild (no OE_TRUST/vouch armed) resolves a human sibling `unauth` — the SAME floor the trigger already sits on for an unvouched guild, not a new behaviour this fix introduces",
);

process.env.OE_TRUST = "internal";
try {
  const gradedVouched = gradeDiscordContextLines(lines, ctx, GUILD);
  ok(gradedVouched[0].trust === "peer", "a VOUCHED guild resolves a human sibling `peer` — mirrors the trigger's own resolveWakeTrustFromContext exactly");
} finally {
  delete process.env.OE_TRUST;
}

console.log("3. the register query carried on each line:");

ok(
  gradedUnvouched[0].authorTrust?.tenantKey === `discord/${GUILD}` && gradedUnvouched[0].authorTrust?.authorId === "U_ALICE",
  "the query is keyed on the GUILD, carrying the raw author id",
);
ok(gradedUnvouched[0].authorTrust?.memberships?.length === 0, "🔴 memberships is ALWAYS empty here — no per-message role data reaches this REST endpoint (verified: no `member` field on it)");
ok(gradedUnvouched[1].authorTrust === undefined, "negative control: the agent's own line carries no authorTrust (not a `user` line)");

const noGuild = gradeDiscordContextLines(lines, ctx, undefined);
ok(noGuild[0].authorTrust === undefined, "🔴 FAIL OPEN: no guild id ⇒ no authorTrust — never a guess at a tenant to arm");

const noSenderId = gradeDiscordContextLines([line("user", undefined, "no id", "9")], ctx, GUILD);
ok(noSenderId[0].authorTrust === undefined, "negative control: a `user` line with no senderId carries no authorTrust either");

console.log("4-5. the join over the graded lines:");

const ingested = gradedUnvouched.map(contextLineIngestion);
ok(ingested[0].authorTrust?.authorId === "U_ALICE", "contextLineIngestion carries authorTrust through unmodified");

ok(
  chatWakeIngestsNonMember([{ trust: "peer" }, ...ingested], {}) === false,
  "🔴 UNARMED: the register contributes nothing on an undeclared guild — byte-identical to before OPE-516 existed on this leg",
);

try {
  registerAuthorTrust([defineAuthorTrust({ tenant: `discord/${GUILD}`, internal: ["discord/U_SOMEONE_ELSE"] })]);
  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }, ...ingested], {}) === true,
    "🔴 ARMED, AUTHOR NOT DECLARED: a MEMBER's trigger whose backscroll hydrates an UNDECLARED guild author's earlier message marks the wake",
  );

  _resetAuthorTrustForTest();
  registerAuthorTrust([defineAuthorTrust({ tenant: `discord/${GUILD}`, internal: ["discord/U_ALICE"] })]);
  ok(
    chatWakeIngestsNonMember([{ trust: "peer" }, ...ingested], {}) === false,
    "negative control: the SAME author, now DECLARED internal, does not mark",
  );
} finally {
  _resetAuthorTrustForTest();
}

console.log(`\n✅ discord contextline trust: ${passed} assertions passed`);
