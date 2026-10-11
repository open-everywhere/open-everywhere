
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingActionRow } from "../agent/approvals/types.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-attention-queue-")), "ops.sqlite3");

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ADMIN"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { recordAttention, attentionWhereOf, blockedPingText, ATTENTION_PING_FAILED_ACTION } = await import("../agent/status/attention.js");
const { waitingOnPerson } = await import("../agent/status/waiting-on-me.js");
const { plainSummaryForRow } = await import("../agent/approvals/plain-summary.js");
const { registerSlackFixtureManifest, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { bindFrom } = await import("../agent/identity/binding.js");
const waitingTool = (await import("../agent/tools/waiting_on_me.js")).default as { execute(i: unknown, c: unknown): Promise<unknown> };
const { PROACTIVE_DM_PLANES } = await import("../agent/channels/proactive-dm-manifest.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;
type DeliverInput = Parameters<typeof import("../agent/channels/dm-audience.js").deliverProactiveDm>[0];

registerSlackFixtureManifest();
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const store = getOperationalStore();
const ORG = "default";
const sent: DeliverInput[] = [];
let failSend = false;
const deliver = async (input: DeliverInput) => {
  if (failSend) throw new Error("slack refused: channel_not_found");
  sent.push(input);
  return { surfaceId: "D-1", messageId: `m-${sent.length}` };
};
const permalink = async (_platform: string, ref: { channelId: string; messageId: string }) => `https://example.slack.com/archives/${ref.channelId}/p${ref.messageId.replace(".", "")}`;
let clock = Date.parse("2026-10-11T09:00:00Z");
const now = () => new Date((clock += 60_000));
const deps = { deliver, permalink, now };

const where = { org: ORG, platform: "slack", workspace: "T1", surface: "C1", surfaceKey: "slack/T1/C1", channelId: "C1", threadTs: "500.1", personId: "U_ME", dm: false } as const;

{
  const w = await recordAttention(where, "sess-1", "working", "reading the logs", deps);
  ok(w.recorded?.state === "working" && !w.pinged, "working is recorded and pings nobody");
  const b1 = await recordAttention(where, "sess-1", "blocked", "need the prod deploy key from you", deps);
  ok(b1.pinged && sent.length === 1, "🔴 ENTERING blocked pings the person once");
  ok(sent[0].recipientId === "U_ME" && sent[0].plane === "attention.blocked", "the ping goes to the session's own person, on the declared attention plane");
  ok(sent[0].text === blockedPingText("need the prod deploy key from you", "https://example.slack.com/archives/C1/p5001"), "the ping carries the status line and a link to the work");
  ok(sent[0].footer.includes("Reply here to ask me to stop"), "the ping carries the host footer that says how to stop it");
  const b2 = await recordAttention(where, "sess-1", "blocked", "still need the key", deps);
  ok(!b2.pinged && sent.length === 1, "🔴 a repeated blocked report pings NOTHING — same episode");
  ok(b2.recorded?.since === b1.recorded?.since, "the episode keeps its start time across repeats");
  ok(b2.recorded?.summary === "still need the key", "the summary still updates");
  const ni = await recordAttention(where, "sess-1", "needs_input", "which region?", deps);
  ok(!ni.pinged && sent.length === 1, "needs_input is listed but does not ping");
  const b3 = await recordAttention(where, "sess-1", "blocked", "blocked again on the key", deps);
  ok(b3.pinged && sent.length === 2, "leaving blocked and entering it again is a NEW episode, and pings again");
}

{
  const before = sent.length;
  const hostile = "<https://evil.example|open the staging password form> @everyone *now*";
  const h = await recordAttention(where, "sess-hostile", "blocked", hostile, deps);
  ok(h.pinged && sent.length === before + 1, "a hostile blocked report still pings once");
  const text = sent[sent.length - 1].text;
  ok(!/[<>|[\]]/u.test(h.recorded?.summary ?? "<"), `🔴 the stored line carries no markup that disguises a link (got "${h.recorded?.summary}")`);
  ok(!/@everyone/u.test(text), "🔴 the ping carries no bare @everyone");
  ok(!text.includes("<https://evil.example|"), "🔴 the ping carries no disguised Slack link");
  const ident = await recordAttention(where, "sess-ident", "working", "need write access to oe_config and file_name.ts", deps);
  ok(ident.recorded?.summary === "need write access to oe_config and file_name.ts", `🔴 an identifier survives the cleaner (got "${ident.recorded?.summary}")`);
  const dbl = await recordAttention(where, "sess-ident", "working", "ping @@everyone", deps);
  ok(!/@everyone/u.test(dbl.recorded?.summary ?? "@everyone"), `a doubled @ leaves no broadcast mention (got "${dbl.recorded?.summary}")`);
  const cutLine = await recordAttention(where, "sess-ident", "working", `${"a".repeat(189)} @everyoneZZ`, deps);
  ok(!/@(everyone|here)\b/iu.test(cutLine.recorded?.summary ?? "@here"), `🔴 a cut status line cannot end in a broadcast mention (got "…${cutLine.recorded?.summary.slice(-14)}")`);
  const markupOnly = await recordAttention(where, "sess-ident", "working", "<|>", deps);
  ok(markupOnly.recorded?.summary === "", `a line of markup only is stored empty, never "(unnamed)" (got "${markupOnly.recorded?.summary}")`);
}

{
  const row = await store.recordAttentionState({ org: ORG, sessionId: "sess-race", state: "blocked", summary: "x", surfaceKey: "slack/T1/C1", channelId: "C1", threadTs: null, personPlatform: "slack", personId: "U_ME", updatedAt: new Date(clock).toISOString() });
  const [first, second] = await Promise.all([store.claimAttentionPing(ORG, "sess-race", row.since), store.claimAttentionPing(ORG, "sess-race", row.since)]);
  ok([first, second].filter(Boolean).length === 1, "two racing claims on one episode: exactly one wins");
}

{
  const before = sent.length;
  const noPerson = await recordAttention({ ...where, personId: undefined }, "sess-nobody", "blocked", "stuck", deps);
  ok(noPerson.recorded !== null && !noPerson.pinged && sent.length === before, "a session with no person records its state and pings nobody");
  const dm = await recordAttention({ ...where, dm: true }, "sess-dm", "blocked", "stuck in a DM", deps);
  ok(dm.recorded === null && !dm.pinged && sent.length === before, "a DM session records nothing — the person is already in that conversation");
  failSend = true;
  const failed = await recordAttention(where, "sess-fail", "blocked", "stuck on the vendor", deps);
  failSend = false;
  ok(!failed.pinged, "a send that fails reports no ping");
  const rows = await readAudit({ org: ORG, action: ATTENTION_PING_FAILED_ACTION });
  ok(rows.some((r) => (r.detail as { sessionId?: string }).sessionId === "sess-fail"), "a failed send writes its own audit row");
  const again = await recordAttention(where, "sess-fail", "blocked", "still stuck", deps);
  ok(!again.pinged && sent.length === before, "the failed episode is not retried — at most once, by construction");
}

{
  const w = attentionWhereOf(
    { org: ORG, platform: "slack", workspace: "T1", surface: "C1", mode: "channel", visibility: "public", trust: "internal", principalId: "U_ME", threadTs: "9.9", target: { channelId: "C1" } } as never,
    "slack/T1/C1",
  );
  ok(w.personId === "U_ME" && w.channelId === "C1" && w.threadTs === "9.9" && !w.dm, "the person, room and thread come from the binding");
  ok(attentionWhereOf({ org: ORG, platform: "slack", workspace: "T1", surface: "D1", mode: "dm", visibility: "private", trust: "internal" } as never, "slack/T1/D1").dm, "a DM binding is marked dm");
  const plane = PROACTIVE_DM_PLANES.find((p) => p.plane === "attention.blocked");
  ok(plane?.stop === "outranks" && plane.recordsDelivery === false, "the attention plane is declared, the person's stop outranks it, and it never marks the chat plane's first-delivery record");
}

function pending(over: Partial<PendingActionRow>): PendingActionRow {
  return {
    id: "q",
    org: ORG,
    kind: "chat.post",
    argsJson: JSON.stringify({ platform: "slack", container: "C7", text: "hello", grant: "g", requestedBy: "U_ME" }),
    scopeKey: "slack/T1/C7",
    domain: null,
    requestedBy: "U_ME",
    channelId: "C7",
    threadTs: null,
    messageTs: "700.1",
    postedTo: "slack/T1/C7",
    status: "pending",
    createdAt: "2026-10-11T08:00:00Z",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...over,
  };
}
{
  const spendArgs = JSON.stringify({ org: ORG, scopeKey: "slack/T1/C8", level: "surface", monthlyUsd: 75, currentCap: null, scopeLabel: "#ops" });
  const mine = pending({ id: "q-mine" });
  await store.addPendingAction(mine);
  await store.addPendingAction(pending({ id: "q-theirs", requestedBy: "U_OTHER" }));
  await store.addPendingAction(pending({ id: "q-admin", kind: "spend.set", argsJson: spendArgs, requestedBy: "U_OTHER", channelId: "C8", messageTs: "800.1", postedTo: "slack/T1/C8", createdAt: "2026-10-11T08:30:00Z" }));
  await store.addPendingAction(pending({ id: "q-expired", expiresAt: "2020-01-01T00:00:00Z" }));
  await store.addPendingAction(pending({ id: "q-unposted", messageTs: null }));
  await store.addPendingAction(pending({ id: "q-discord", postedTo: "discord/G1/C9" }));

  const asMember = await waitingOnPerson({ org: ORG, platform: "slack", workspace: "T1", personId: "U_ME" }, { permalink, now: () => new Date() });
  const ids = asMember.items.map((i) => i.sentence);
  ok(asMember.items.some((i) => i.kind === "approval" && i.sentence === plainSummaryForRow(mine) && i.status.startsWith("you can decide")), "🔴 a member card my own work raised is in my queue, as its plain sentence, and I can decide it");
  ok(asMember.items.some((i) => i.link === "https://example.slack.com/archives/C7/p7001"), "the card item carries a link to the card");
  ok(!asMember.items.some((i) => i.status.includes("(admin)")), "a non-admin is not shown admin cards as theirs to decide");
  ok(asMember.items.filter((i) => i.kind === "approval").length === 1, `exactly one card is mine: not another person's member card, not an expired, unposted or other-platform one (got ${JSON.stringify(ids)})`);
  ok(asMember.items.some((i) => i.kind === "attention" && i.sentence === "blocked again on the key" && i.status === "a job is blocked on you"), "a job blocked on me is in my queue");
  ok(asMember.items.some((i) => i.kind === "attention" && i.link === "https://example.slack.com/archives/C1/p5001"), "the job item links to the work");
  ok(asMember.message.split("\n")[0].includes("waiting on you"), "the message opens with a plain count");
  ok(asMember.message.includes(plainSummaryForRow(mine)) && asMember.message.includes("https://example.slack.com/archives/C7/p7001"), "the message carries each sentence and its link");

  const asAdmin = await waitingOnPerson({ org: ORG, platform: "slack", workspace: "T1", personId: "U_ADMIN" }, { permalink, now: () => new Date() });
  ok(asAdmin.items.some((i) => i.status.startsWith("you can decide (admin)") && i.sentence.includes("#ops")), "an org admin's queue lists the admin-tier card their roster entry can decide");
  ok(!asAdmin.items.some((i) => i.kind === "attention"), "an admin's queue does not list another person's blocked jobs");

  const empty = await waitingOnPerson({ org: ORG, platform: "slack", workspace: "T1", personId: "U_NOBODY" }, { permalink, now: () => new Date() });
  ok(empty.items.length === 0 && empty.message.startsWith("Nothing is waiting on you"), "an empty queue says so plainly");
}

{
  const ctx = (opts: { channel?: boolean; attested?: boolean } = {}): BindableContext =>
    ({
      channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:dm" },
      session: {
        auth: {
          current: {
            attributes: {
              channel_id: opts.channel === true ? "C-ROOM" : "D-ME",
              channel_type: opts.channel === true ? "channel" : "im",
              oe_grain: "standing",
              oe_platform: "slack",
              team_id: "T1",
              trust_checked: "true",
              ...(opts.attested === true ? { oe_fire_unattended: "true" } : {}),
            },
            principalId: "U_ME",
            principalType: "slack-user",
          },
        },
        id: "dm-U_ME",
      },
    }) as unknown as BindableContext;
  const call = (c: BindableContext) => inEveContext(new FakeEveContext(), async () => (await waitingTool.execute({}, c)) as { count: number; message: string });
  const refusal = async (c: BindableContext): Promise<string> => {
    try {
      await call(c);
      return "(no refusal)";
    } catch (err) {
      return String(err);
    }
  };
  ok(bindFrom(ctx({ channel: true })).mode === "channel", "fixture: the channel ctx binds as a channel");
  ok((await refusal(ctx({ channel: true }))).includes("DM-only"), "🔴 a CHANNEL seat is refused — the DM wall");
  ok((await refusal(ctx({ attested: true }))).includes("needs the person to be here"), "an unattended fire is refused — no acting person, no queue");
  const answer = await call(ctx());
  ok(answer.count >= 2 && answer.message.includes("waiting on you"), "in the person's own DM it answers with their queue");
}

console.log(`attention-queue-test: ${n} assertions passed`);
