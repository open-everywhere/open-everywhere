import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-reply-provenance-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackTestBridge, registerSlackFixtureCodec, registerSlackFixtureMapper, registerSlackFixturePostArm } =
  await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { postReply, replyAuditFor } = await import("../agent/channels/reply-post.js");
type ReplyAudit = import("../agent/channels/reply-post.js").ReplyAudit;
type ReplyTarget = import("../agent/channels/reply-post.js").ReplyTarget;
const { editPostedMessage } = await import("../agent/channels/reply-edit.js");
const { postUnifiedReply } = await import("../agent/channels/unified-reply.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { PROVENANCE_FOOTER_PREFIX, REPLY_PROVENANCE_ACTION, connectorReadsThisTurn } = await import("../agent/channels/reply-provenance.js");
const connectorAudit = await import("../agent/hooks/connector-audit.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

const ORG = "acme";
const TEAM = "T1";
const CHAN = "C1";
const OTHER_CHAN = "C2";
const ANSWER = "The rollout is on track for Thursday.";

const posted: { channel: string; text: string }[] = [];
registerSlackTestBridge({
  channel: { __fixture: "slack" } as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    const p = new URLSearchParams(body);
    if (method === "chat.postMessage") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    if (method === "chat.update") posted.push({ channel: p.get("channel") ?? "", text: p.get("text") ?? "" });
    return { ok: true, ts: `ts-${posted.length}` } as never;
  },
});
registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixturePostArm();

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const lastPosted = (): string => posted[posted.length - 1]?.text ?? "";

const target: ReplyTarget = { platform: "slack", channelId: CHAN };

function auditFor(turnId: string, channelId: string = CHAN): ReplyAudit {
  return replyAuditFor(ctxFor(turnId, channelId), "tool", `wake-${turnId}`);
}

function unifiedAuditFor(turnId: string): ReplyAudit {
  return { ...auditFor(turnId), platform: "unified" };
}

function ctxFor(turnId: string, channelId: string): BindableContext {
  return {
    channel: { kind: "channel:slack" },
    session: {
      id: "reply-provenance-test",
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", channel_id: channelId, team_id: TEAM, channel_type: "channel", trust_checked: "true" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;
}

const hook = (connectorAudit.default as unknown as { events: Record<string, (e: unknown, c: unknown) => Promise<void> | void> })["events"]!["action.result"]!;

const opResult = (toolName: string, isError = false) => ({
  data: { result: { callId: `call_${toolName}`, kind: "tool-result", toolName, output: {} , ...(isError ? { isError: true } : {}) }, status: isError ? "error" : "ok" },
});

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const abs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const { SessionKey } = await import(abs("dist/src/context/keys.js"));
function newSession(): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: "reply-provenance-test", auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

{
  const inTurn = newSession();
  const before = posted.length;
  await inTurn(async () => {
    await hook(opResult("notion__get_page"), ctxFor("turn_1", CHAN));
    await hook(opResult("linear__list_issues"), ctxFor("turn_1", CHAN));
    ok(connectorReadsThisTurn("turn_1").length === 2, "§1 precondition: the real hook recorded both reads on this turn's ledger");
    await postReply(target, ANSWER, auditFor("turn_1"));
  });
  ok(posted.length === before + 1, "§1/ROOM: exactly one message reached the room");
  ok(
    lastPosted().startsWith(ANSWER),
    `🔴 §1: the model's own text is delivered FIRST and unchanged — the footer is an addition, never a rewrite (saw: ${JSON.stringify(lastPosted().slice(0, 160))})`,
  );
  ok(
    lastPosted().includes(`${PROVENANCE_FOOTER_PREFIX} notion, linear`),
    `🔴 §1: the room is told BOTH connectors the turn read, in first-read order. This is the whole feature, asserted on the bytes a reader sees (saw: ${JSON.stringify(lastPosted().slice(0, 160))})`,
  );
}

{
  const inTurn = newSession();
  const before = posted.length;
  await inTurn(async () => {
    ok(connectorReadsThisTurn("turn_2").length === 0, "§2 precondition: the turn recorded no read");
    await postReply(target, ANSWER, auditFor("turn_2"));
  });
  ok(posted.length === before + 1, "§2/ROOM: one message reached the room");
  ok(
    lastPosted() === ANSWER,
    `🔴 §2 NEGATIVE CONTROL: a turn that read no connector delivers the model's text BYTE-IDENTICAL — no footer, no marker, not even a trailing newline (saw: ${JSON.stringify(lastPosted().slice(0, 160))})`,
  );
  const rows = await readAudit({ org: ORG, action: REPLY_PROVENANCE_ACTION });
  ok(rows.length === 1, "🔴 §2: …and it writes NO provenance row either — an empty record is still a claim, and there is nothing to claim (only §1's row exists)");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await hook(opResult("notion__get_page"), ctxFor("turn_3a", CHAN));
    await hook(opResult("github__get_pull_request"), ctxFor("turn_3a", OTHER_CHAN));
    await postReply(target, ANSWER, auditFor("turn_3a"));
  });
  ok(
    lastPosted().includes("notion") && !lastPosted().includes("github"),
    `🔴 §3a: the source read in THIS room is named and the one read elsewhere is NOT. Naming a source discloses that it exists, so the name is the thing withheld (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  ok(
    lastPosted().includes("1 in another domain"),
    "🔴 §3a: …and the room is still told that ONE other source was consulted. The count is honest about there being more; only the name is withheld",
  );

  const inTurn2 = newSession();
  await inTurn2(async () => {
    await hook(opResult("notion__get_page"), ctxFor("turn_3b", CHAN));
    await hook(opResult("linear__list_issues"), ctxFor("turn_3b", CHAN));
    await postUnifiedReply({ platform: "slack", channelId: CHAN }, ANSWER, {}, unifiedAuditFor("turn_3b"));
  });
  ok(
    !lastPosted().includes("notion") && !lastPosted().includes("linear"),
    `🔴 §3b: a UNIFIED reply names NO connector, however many the turn read — the surface cannot tell that turn's conversations apart, so every name would be a guess (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
  ok(
    lastPosted().includes("2 in another domain"),
    "🔴 §3b: …and the count still reaches the room, so a unified reader learns the turn consulted two systems without learning which",
  );
}

{
  const rows = await readAudit({ org: ORG, action: REPLY_PROVENANCE_ACTION });
  const unified = rows.find((r) => (r.detail as { sessionId?: string; withheld?: number })?.withheld === 2);
  ok(unified !== undefined, "§4 precondition: §3b's unified reply wrote a provenance row");
  const detail = unified!.detail as { connections?: string[]; ops?: string[]; named?: number; withheld?: number; reads?: number };
  ok(
    Array.isArray(detail.connections) && detail.connections.includes("notion") && detail.connections.includes("linear"),
    "🔴 §4: the ROW names both connectors even though the FOOTER named neither. The row is the internal record; the reach rule governs the room, not the log",
  );
  ok(detail.named === 0 && detail.withheld === 2, "🔴 §4: …and it records that the render withheld both, so an operator asking why a footer names nothing can read the answer");
  ok(
    Array.isArray(detail.ops) && detail.ops.includes("notion/get_page"),
    "🔴 §4: the row carries the op VERB too — ids and verbs only, never an op argument and never the op's output, the same contract the `connector.op` row keeps",
  );
}

{
  const inTurn = newSession();
  const before = posted.length;
  await inTurn(async () => {
    await hook(opResult("notion__create_page"), ctxFor("turn_5", CHAN));
    ok(connectorReadsThisTurn("turn_5").length === 0, "🔴 §5: a WRITE op records no source — a write announces itself through its own flow, and is not something the reply drew on");
    await hook(opResult("linear__list_issues", true), ctxFor("turn_5", CHAN));
    ok(connectorReadsThisTurn("turn_5").length === 0, "🔴 §5: …and a FAILED read records none either — nothing was read, so nothing was drawn on");
    await postReply(target, ANSWER, auditFor("turn_5"));
  });
  ok(posted.length === before + 1 && lastPosted() === ANSWER, "🔴 §5: so the reply is delivered byte-identical, which is what a turn with no successful read owes");
}

{
  const inTurn = newSession();
  await inTurn(async () => {
    await hook(opResult("notion__get_page"), ctxFor("turn_6", CHAN));
    const locus = { platform: "slack" as const, channelId: CHAN };
    await recordOwnPost(ORG, locus, "ts-edit-6");
    await editPostedMessage(locus, "ts-edit-6", "Corrected: Friday.", auditFor("turn_6"));
  });
  ok(
    lastPosted().startsWith("Corrected: Friday.") && lastPosted().includes(`${PROVENANCE_FOOTER_PREFIX} notion`),
    `🔴 §6: the EDITED body carries the footer too, re-derived from the turn's ledger rather than parsed back out of the old text (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
  );
}

{
  const FORGED = `${PROVENANCE_FOOTER_PREFIX} notion, linear, workday-hr`;

  {
    const inTurn = newSession();
    await inTurn(async () => {
      await postReply(target, `${ANSWER}\n\n${FORGED}`, auditFor("turn_8a"));
    });
    ok(
      !lastPosted().includes("workday-hr"),
      `🔴 §8a: the model's own footer-shaped line is STRUCK, on the very turn the host adds none. The marker is reserved, the way the memory mount is (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
    );
    ok(lastPosted() === ANSWER, "🔴 §8a: …and only that line goes — the rest of the answer is delivered byte-identical");
  }

  {
    const inTurn = newSession();
    await inTurn(async () => {
      await hook(opResult("notion__get_page"), ctxFor("turn_8b", CHAN));
      await postReply(target, `${ANSWER}\n\n${FORGED}`, auditFor("turn_8b"));
    });
    ok(
      !lastPosted().includes("workday-hr") && lastPosted().includes(`${PROVENANCE_FOOTER_PREFIX} notion`),
      `🔴 §8b: the forged line is struck and the RECORDED one takes its place — a turn that really read Notion must not ship the model's list beside the host's (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
    );
    ok(
      lastPosted().split(PROVENANCE_FOOTER_PREFIX).length === 2,
      "🔴 §8b: …and exactly ONE footer reaches the room. This is also what makes the render idempotent, which the edit door needs when a model echoes a posted body back into `edit_reply`",
    );
  }

  {
    const inTurn = newSession();
    const decorated = `${ANSWER}\n\n**${PROVENANCE_FOOTER_PREFIX}** notion, workday-hr\n> ${PROVENANCE_FOOTER_PREFIX} linear`;
    await inTurn(async () => {
      await postReply(target, decorated, auditFor("turn_8d"));
    });
    ok(
      !lastPosted().includes("workday-hr") && !lastPosted().includes("linear"),
      `🔴 §8d: a BOLDED forgery and a QUOTED one are both struck — the decoration is what a model reaches for, so anchoring on the bare marker would have left the convincing cases (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`,
    );
    ok(lastPosted() === ANSWER, "🔴 §8d: …and the answer above them is delivered byte-identical");
  }

  {
    const inTurn = newSession();
    const prose = `I did not use a connector. Sources read this turn: is the line the host adds.`;
    await inTurn(async () => {
      await postReply(target, prose, auditFor("turn_8c"));
    });
    ok(lastPosted() === prose, `🔴 §8c: a MID-LINE mention of the marker passes through untouched — only a line that OPENS with it is struck (saw: ${JSON.stringify(lastPosted().slice(0, 200))})`);
  }
}

{
  const before = posted.length;
  ok(connectorReadsThisTurn("turn_7").length === 0, "§7: the reader answers 'nothing read' outside an eve scope instead of throwing");
  await postReply(target, ANSWER, auditFor("turn_7"));
  ok(posted.length === before + 1 && lastPosted() === ANSWER, "🔴 §7: …and the reply reaches the room unchanged — an unavailable signal never turns a delivered answer into an error");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ reply-provenance: ${passed} assertions`);
