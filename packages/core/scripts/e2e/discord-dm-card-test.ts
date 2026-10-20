import assert from "node:assert/strict";
import type { AuditWireEntry } from "./audit-read.js";
import { discordDmCardSteps, discordDmCardVerdict, dmSeatDecisionWake, isDiscordDmCard } from "./discord-dm-card.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n += 1;
};

const USER = "111111111111111111";
const DM = "222222222222222222";
const GUILD = "333333333333333333";
const ROOM = "444444444444444444";
const DM_KEY = `discord/${USER}/${DM}`;

const row = (action: string, ts: string, detail: Record<string, unknown>, extra: Partial<AuditWireEntry> = {}): AuditWireEntry => ({
  ts,
  org: "default",
  platform: "discord",
  workspace: USER,
  action,
  detail,
  ...extra,
});
const card = (ts: string, id: string, scopeKey = DM_KEY, more: Record<string, unknown> = {}, principalId = USER) =>
  row("approval.requested", ts, { id, kind: "op.connector", scopeKey, ...more }, { principalId });
const approved = (ts: string, id: string) => row("approval.approved", ts, { id }, { principalId: USER });
const opApproved = (ts: string) => row("connector.op_approved", ts, { requestedBy: USER }, { principalId: USER });
const wake = (ts: string, id: string, domain: string, delivered = true) =>
  row("approval.decision_wake", ts, { id, kind: "op.connector", outcome: "approved", domain, delivered, wakeId: "w-1" }, { principalId: USER });
const write = (ts: string, surface = DM) => row("connector.op", ts, { opTier: "write", op: "notion-create-pages", status: "ok" }, { surface });

ok(isDiscordDmCard(card("2026-10-20T10:00:00Z", "p1")), "§1: the requester's own id in the key's middle segment marks a DM card");
ok(isDiscordDmCard(card("2026-10-20T10:00:00Z", "p1", DM_KEY, {}, `discord/${USER}`)), "§1: a `discord/<id>` requester reads the same");
ok(!isDiscordDmCard(card("2026-10-20T10:00:00Z", "p1", `discord/${GUILD}/${ROOM}`, { domain: "e2e-unified" })), "§1: a guild room's card is not a DM card");
ok(!isDiscordDmCard(card("2026-10-20T10:00:00Z", "p1", `slack/T0/D0`, {}, "T0")), "§1: a Slack card is not a Discord DM card");
ok(!isDiscordDmCard(card("2026-10-20T10:00:00Z", "p1", DM_KEY, {}, "")), "§1: a card with no requester is not a DM card");
ok(!isDiscordDmCard(row("approval.requested", "2026-10-20T10:00:00Z", { id: "p1", kind: "spend.set", scopeKey: DM_KEY }, { principalId: USER })), "§1: a non-connector card is not this leg's card");

ok(discordDmCardVerdict([]).kind === "no-card", "§2: no rows → no-card");
ok(discordDmCardVerdict([card("2026-10-20T10:00:00Z", "p1", `discord/${GUILD}/${ROOM}`)]).kind === "no-card", "§2: a guild card alone → no-card");
{
  const v = discordDmCardVerdict([card("2026-10-20T10:00:00Z", "p1")]);
  ok(v.kind === "undecided" && v.card.pendingId === "p1" && v.card.channelId === DM, `§2: an untapped card → undecided, with its DM channel (got ${JSON.stringify(v)})`);
}
ok(discordDmCardVerdict([card("2026-10-20T10:00:00Z", "p1"), row("approval.rejected", "2026-10-20T10:01:00Z", { id: "p1" })]).kind === "rejected", "§2: a rejected card → rejected");

{
  const v = discordDmCardVerdict([card("2026-10-20T09:00:00Z", "old"), approved("2026-10-20T09:01:00Z", "old"), card("2026-10-20T10:00:00Z", "new")]);
  ok(v.kind === "undecided" && v.card.pendingId === "new", "§3: a newer untapped card wins over an older approved one");
}

const chain = [
  card("2026-10-20T10:00:00Z", "p1"),
  opApproved("2026-10-20T10:05:00Z"),
  approved("2026-10-20T10:05:01Z", "p1"),
  wake("2026-10-20T10:05:02Z", "p1", `oe-dm/${DM_KEY}`),
  write("2026-10-20T10:05:30Z"),
];
{
  const v = discordDmCardVerdict(chain);
  assert.ok(v.kind === "approved");
  ok(v.opApproved !== undefined, "§4: the connector.op_approved row joins the tap");
  ok(v.decisionWakes.length === 1 && dmSeatDecisionWake(v.decisionWakes[0]!, v.card), "§4: the delivered decision wake on the DM seat's domain proves the wake");
  ok(v.writesBeforeApproval.length === 0, "§4: no write ran before the tap");
  ok(v.writeAfter?.ts === "2026-10-20T10:05:30Z", "§4: the write after the tap is found");
}
{
  const v = discordDmCardVerdict([...chain.slice(0, 3), wake("2026-10-20T10:05:02Z", "p1", `oe-dm/${DM_KEY}`, false), chain[4]!]);
  assert.ok(v.kind === "approved");
  ok(!dmSeatDecisionWake(v.decisionWakes[0]!, v.card), "§4: an UNDELIVERED decision wake proves nothing");
}
{
  const v = discordDmCardVerdict([...chain.slice(0, 3), wake("2026-10-20T10:05:02Z", "p1", "e2e-unified"), chain[4]!]);
  assert.ok(v.kind === "approved");
  ok(!dmSeatDecisionWake(v.decisionWakes[0]!, v.card), "§4: a decision wake on a guild domain is not the DM seat");
  const other = discordDmCardVerdict([...chain.slice(0, 3), wake("2026-10-20T10:05:02Z", "p1", `oe-dm/discord/${USER}/999`), chain[4]!]);
  assert.ok(other.kind === "approved");
  ok(!dmSeatDecisionWake(other.decisionWakes[0]!, other.card), "§4: a decision wake on ANOTHER DM's seat is not this card's");
}
{
  const v = discordDmCardVerdict([...chain.slice(0, 1), write("2026-10-20T10:02:00Z"), ...chain.slice(1)]);
  assert.ok(v.kind === "approved");
  ok(v.writesBeforeApproval.length === 1, "§4: a write between the card and the tap is caught");
}
{
  const other = row("connector.op_approved", "2026-10-20T10:05:00Z", { requestedBy: "555555555555555555" }, { principalId: USER });
  const v = discordDmCardVerdict([chain[0]!, other, ...chain.slice(2)]);
  assert.ok(v.kind === "approved");
  ok(v.opApproved === undefined, "§4: the same person's op_approved row for ANOTHER requester's card does not join this tap");
}
{
  const v = discordDmCardVerdict([...chain.slice(0, 4), write("2026-10-20T10:05:30Z", ROOM)]);
  assert.ok(v.kind === "approved");
  ok(v.writeAfter === undefined, "§4: a write in another room is not the DM's write");
  const failed = discordDmCardVerdict([...chain.slice(0, 4), row("connector.op", "2026-10-20T10:05:30Z", { opTier: "write", status: "error" }, { surface: DM })]);
  assert.ok(failed.kind === "approved");
  ok(failed.writeAfter === undefined, "§4: a failed write is no write");
}

ok(discordDmCardSteps("tok-1").includes("OE discord-card tok-1") && discordDmCardSteps("tok-1").includes("24 hours"), "§5: the steps name the page title and the window");

console.log(`discord-dm-card: ${n} checks passed`);
