import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(tmpdir(), `open-everywhere-chat-dm-approval-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { readDmAudience, dmDeliveryFooter } = await import("../agent/channels/dm-audience.js");
type ChatDmArgs = import("../agent/approvals/chat-dm.js").ChatDmArgs;
await import("../agent/approvals/flow.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const PLATFORM = "test-dm-platform";
const sent: { principalId: string; text: string }[] = [];
let lands = true;
registerPostArm({
  platform: PLATFORM,
  deliverDirectMessage: async (input) => {
    if (!lands) throw new Error("the recipient has direct messages turned off");
    sent.push({ principalId: input.principalId, text: input.text });
    return { surfaceId: "D-1", messageId: "M-1" };
  },
});

const GRANT = `${PLATFORM}:person/U_SARAH`;
const FOOTER = dmDeliveryFooter({ requestedBy: "U_PROPOSER", fromContainer: "slack/T1/C_HOME" });
function args(over: Partial<ChatDmArgs> = {}): ChatDmArgs {
  return {
    org: "default",
    scopeKey: "slack/T1/C_HOME",
    platform: PLATFORM,
    principalId: "U_SARAH",
    grant: GRANT,
    text: "The build is fixed, you can re-run your deploy.",
    footer: FOOTER,
    requestedBy: "U_PROPOSER",
    ...over,
  };
}

{
  const kind = actionKind("chat.dm");
  ok(kind !== undefined, "chat.dm is registered through approvals/flow.ts");
  ok(kind!.policy === "member", "chat.dm gates at `member` — the audience axis, like ticket.create and chat.post");
}

{
  const kind = actionKind("chat.dm")!;
  const lines = kind.summarize(args()) as string[];
  const all = lines.join("\n");
  ok(all.includes("U_SARAH"), "the card names the RECIPIENT");
  ok(all.includes(GRANT), "the card names the GRANT that admitted them");
  ok(all.includes("The build is fixed, you can re-run your deploy."), "the card renders the FULL body — it is the injection gate");
  ok(all.includes(FOOTER.trim()), "the card echoes the footer VERBATIM, so the approver can check the recipient is told how to stop it");
  ok(
    all.includes("without a card"),
    "the card states the REAL scope of the click: approving also opens the flowing path for later messages",
  );
  ok(!all.includes("⚠"), "an untainted proposal carries no warning banner");

  const tainted = (kind.summarize(args({ tainted: true })) as string[]).join("\n");
  ok(tainted.includes("⚠") && tainted.includes("external content"), "a tainted proposal carries the reviewer-scrutiny banner");
  ok(tainted.includes("The build is fixed, you can re-run your deploy."), "the tainted card still renders the full body — taint discloses, it never truncates");
}

{
  const kind = actionKind("chat.dm")!;
  const note = await kind.execute(args(), "U_APPROVER");
  ok(sent.length === 1, "the approved delivery reaches the FROZEN platform's DM transport exactly once");
  ok(sent[0]!.principalId === "U_SARAH", "it is addressed to the frozen recipient");
  ok(sent[0]!.text.startsWith("The build is fixed"), "the model's body goes first");
  ok(sent[0]!.text.endsWith(FOOTER), "the HOST footer is appended to what the recipient sees");
  ok(typeof note === "string" && note.includes("U_SARAH"), "the decision note names who was messaged");

  const audience = await readDmAudience("default", GRANT);
  ok(audience.delivered, "the approved first delivery records that this person has been delivered to");
  ok(!audience.stopped, "delivering does not stop anything");

  const rows = (await readAudit({ org: "default" })).filter((r) => r.action === "chat.dm");
  ok(rows.length === 1, "one audit row per delivery");
  const detail = rows[0]!.detail as Record<string, unknown>;
  ok(detail.recipient === "U_SARAH", "the audit row names the recipient");
  ok(detail.grant === GRANT, "the audit row names the grant that allowed it");
  ok(detail.first === true, "a carded delivery is recorded as the FIRST one");
  ok(detail.messageId === "M-1" && detail.surfaceId === "D-1", "the audit row carries the delivered ids");
  ok(rows[0]!.principalId === "U_APPROVER", "the row is attributed to the human who clicked");
  ok(detail.requestedBy === "U_PROPOSER", "and it still names who asked for it");
  ok(!("text" in detail) && !("footer" in detail), "the audit row carries NO message content");
}

{
  const kind = actionKind("chat.dm")!;
  lands = false;
  let message = "";
  try {
    await kind.execute(args({ principalId: "U_UNREACHABLE" }), "U_APPROVER");
  } catch (e) {
    message = (e as Error).message;
  }
  ok(message.length > 0, "a refused delivery THROWS rather than reporting a message that never arrived");
  lands = true;
}

{
  const kind = actionKind("chat.dm")!;
  let message = "";
  try {
    await kind.execute(args({ platform: "notion" }), "U_APPROVER");
  } catch (e) {
    message = (e as Error).message;
  }
  ok(message.includes("no DM-delivery arm"), "a platform that cannot DM refuses out loud rather than faking a delivery");
}

{
  const { deliverProactiveDm } = await import("../agent/channels/dm-audience.js");
  const before = (await readAudit({ org: "default" })).filter((r) => r.action === "chat.dm").length;
  await deliverProactiveDm({
    where: { org: "default", platform: "slack", workspace: "T1", surface: "slack/T1/C_HOME" },
    platform: PLATFORM,
    recipientId: "U_SARAH",
    address: GRANT,
    text: "A later message.",
    footer: FOOTER,
    requestedBy: "U_PROPOSER",
    attributedTo: "U_PROPOSER",
    first: false,
  });
  const rows = (await readAudit({ org: "default" })).filter((r) => r.action === "chat.dm");
  ok(rows.length === before + 1, "the flowing arm writes one row under the SAME action as the carded arm");
  const flowing = rows.find((r) => (r.detail as Record<string, unknown>).first === false)!;
  ok(flowing !== undefined, "a flowing delivery is recorded with first:false");
  const carded = rows.find((r) => (r.detail as Record<string, unknown>).first === true)!;
  ok(
    Object.keys(flowing.detail as object).sort().join(",") === Object.keys(carded.detail as object).sort().join(","),
    "the flowing row and the carded row carry IDENTICAL fields — a reviewer asks the same questions of both",
  );
  ok(sent[sent.length - 1]!.text.endsWith(FOOTER), "the flowing arm appends the same host footer");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ chat-dm-approval: ${n} assertions`);
