// proves: chat.dm

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-chat-dm-approval-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { renderFriendlyText } = await import("../agent/channels/friendly-ids.js");
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
const FOOTER = dmDeliveryFooter({ platform: PLATFORM, recipientId: "U_SARAH", requestedBy: "U_PROPOSER", from: "slack/T1/C_HOME" });
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
  ok(all.includes("a test-dm-platform person"), "on a platform with no mention syntax and no display name, the card names the recipient in plain words (OPE-2462)");
  const named = (kind.summarize(args({ recipientLabel: "Sarah Lin" })) as string[]).join("\n");
  ok(named.includes("Start a direct message with Sarah Lin"), "…and by display name when propose resolved one");
  const slackCard = (kind.summarize(args({ platform: "slack" })) as string[]).join("\n");
  ok(slackCard.includes("<@U_SARAH>"), "on Slack the card names the RECIPIENT as a mention");
  ok(!all.includes(GRANT) && !/person U_SARAH/.test(all), "the card prints no grant address and no bare member id");
  ok(all.includes("whom an operator granted"), "the card says an operator grant admitted them, in words — the grant address stays on the frozen args and the audit row (OPE-2462)");
  ok(all.includes("The build is fixed, you can re-run your deploy."), "the card renders the FULL body — it is the injection gate");
  ok(all.includes(FOOTER.trim()), "the card echoes the footer VERBATIM, so the approver can check the recipient is told how to stop it");
  ok(
    all.includes("without a card"),
    "the card states the REAL scope of the click: approving also opens the flowing path for later messages",
  );
  ok(!all.includes("⚠"), "a proposal carries no warning banner");

  const legacy = (kind.summarize(Object.assign(args(), { tainted: true })) as string[]).join("\n");
  ok(legacy === all, "a legacy tainted card renders exactly the clean card, with no banner");
}

{
  const kind = actionKind("chat.dm")!;
  const note = await kind.execute(args(), "U_APPROVER");
  ok(sent.length === 1, "the approved delivery reaches the FROZEN platform's DM transport exactly once");
  ok(sent[0]!.principalId === "U_SARAH", "it is addressed to the frozen recipient");
  ok(sent[0]!.text.startsWith("The build is fixed"), "the model's body goes first");
  ok(sent[0]!.text.endsWith(renderFriendlyText(FOOTER, { platform: PLATFORM })), "the HOST footer is appended to what the recipient sees");
  ok(!/<#C_HOME>/.test(sent[0]!.text), "…with the Slack channel mention in words: this platform would print it raw");
  ok(typeof note === "string" && note.includes("sent a direct message to a test-dm-platform person") && !note.includes("U_SARAH"), "the decision note says who was messaged, in words (OPE-2462)");

  const audience = await readDmAudience("default", GRANT);
  ok(audience.delivered, "the approved first delivery records that this person has been delivered to");
  ok(!audience.stopped, "delivering does not stop anything");

  const rows = (await readAudit({ org: "default" })).filter((r) => r.action === "chat.dm");
  ok(rows.length === 1, "one audit row per delivery");
  const detail = rows[0]!.detail as Record<string, unknown>;
  ok(detail.recipient === "U_SARAH", "the audit row names the recipient");
  ok(detail.grant === GRANT, "the audit row names the grant that allowed it");
  ok(detail.first === true, "a carded delivery is recorded as the FIRST one");
  ok(!("tainted" in detail), "a carded delivery's audit row claims no taint value (OPE-2717: the card freezes none, so the row never says false)");
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
    plane: "chat.dm",
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
  ok(!("tainted" in (flowing.detail as Record<string, unknown>)), "the flowing row carries no taint stamp (OPE-2721)");
  const keys = (d: unknown) => Object.keys(d as object).sort().join(",");
  ok(keys(flowing.detail) === keys(carded.detail), "the flowing row and the carded row carry IDENTICAL fields");
  ok(sent[sent.length - 1]!.text.endsWith(renderFriendlyText(FOOTER, { platform: PLATFORM })), "the flowing arm appends the same host footer");
}

await removeTempDir(dir);
console.log(`✓ chat-dm-approval: ${n} assertions`);

// proves: AP-MOD-core-approvals-chat-dm
