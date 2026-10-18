import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-worker-reply-wake-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme", workspace: "dev" });

const { registerSlackFixtureCodec, registerSlackFixtureManifest, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { registerPostArm } = await import("../agent/channels/post-arms.js");
const { postReply, replyAuditFor, replyRowWakeId } = await import("../agent/channels/reply-post.js");
const { editPostedMessage } = await import("../agent/channels/reply-edit.js");
const { recordOwnPost } = await import("../agent/channels/own-post-ledger.js");
const { baseReplyEntry } = await import("../agent/tools/reply.js");
const { OE_WORK_SEAT_WAKE_ATTR, bindFrom } = await import("../agent/identity/binding.js");
const { adoptDelegatedAuthority } = await import("../agent/identity/delegated-binding.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { readAudit } = await import("../agent/audit/audit.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;

registerSlackFixtureCodec();
registerSlackFixtureMapper();
registerSlackFixtureManifest();
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const ORG = "acme";
const TEAM = "T1";
const CHAN = "C1";
const SEAT_SESSION = "seat-session-1";
const FIRE_WAKE = "4a37c7fa-4327-4cf0-a15d-7d36d8ced3c4";

let posted = 0;
registerPostArm({
  platform: "slack",
  resolveTarget: (bag) => {
    const channelId = bag.str("channelId");
    return channelId ? { platform: "slack", channelId } : null;
  },
  dispatchReply: async () => `ts-${++posted}`,
  editMessage: async () => undefined,
});

function bag(): Record<string, string> {
  return {
    oe_platform: "slack",
    oe_grain: "standing",
    channel_id: CHAN,
    team_id: TEAM,
    channel_type: "channel",
    trust_checked: "true",
    [OE_WORK_SEAT_WAKE_ATTR]: FIRE_WAKE,
  };
}

function workerCtx(turnId: string): BindableContext {
  return {
    channel: { kind: "subagent", continuationToken: `subagent:${SEAT_SESSION}:call_1` },
    session: {
      id: "wrun_worker_1",
      parent: { sessionId: SEAT_SESSION, callId: "call_1" },
      turn: { id: turnId, sequence: 1 },
      auth: { current: { attributes: bag(), principalId: "U1", principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "worker" },
  } as unknown as BindableContext;
}

function seatCtx(turnId: string): BindableContext {
  return {
    channel: { kind: "channel:slack" },
    session: {
      id: SEAT_SESSION,
      turn: { id: turnId, sequence: 1 },
      auth: { current: { attributes: bag(), principalId: "U1", principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as unknown as BindableContext;
}

async function rowFor(action: string, id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await readAudit({ org: ORG, action });
  return rows.find((r) => (r.detail as { id?: unknown } | undefined)?.id === id)?.detail as Record<string, unknown> | undefined;
}

const WORKER = new FakeEveContext();
const inWorker = <T>(f: () => Promise<T>): Promise<T> => inEveContext(WORKER, f);
await inWorker(async () => {
  ok(
    adoptDelegatedAuthority({ binding: bindFrom(seatCtx("turn-adopt")), requester: { kind: "requester", principalId: "U1" }, nonMemberWake: false }, undefined),
    "setup: the worker adopts the seat's dispatch binding",
  );
});

const execReply = (baseReplyEntry as unknown as { execute: (i: unknown, c: unknown) => Promise<{ posted: boolean; id: string }> }).execute;

await inWorker(async () => {
  const out = await execReply({ text: "The deploy finished green." }, workerCtx("turn-w1"));
  ok(out.posted === true, `§1: the worker's reply posts (saw ${JSON.stringify(out)})`);
  const detail = await rowFor("reply.post", out.id);
  ok(detail !== undefined, "§1: the worker's post writes one reply.post row");
  ok(
    detail?.wakeId === FIRE_WAKE,
    `🔴 §1: the worker's reply.post row carries the seat wake the host stamped on the forward — the join deploy:smoke reads (saw ${String(detail?.wakeId)})`,
  );
  ok(detail?.sessionId === "wrun_worker_1", `§1: the row still names the worker's own session (saw ${String(detail?.sessionId)})`);
});

{
  const out = await execReply({ text: "A seat answer." }, seatCtx("turn-s1"));
  const detail = await rowFor("reply.post", out.id);
  ok(detail !== undefined, "§2: the seat's post writes one reply.post row");
  ok(detail?.wakeId === undefined, `🔴 §2: a seat's per-surface row carries no wake — the stamp counts only on a child (saw ${String(detail?.wakeId)})`);
}

await inWorker(async () => {
  const audit = replyAuditFor(workerCtx("turn-w2"), "tool");
  ok(audit.wakeId === undefined, `🔴 §3: the worker's audit holds NO wakeId, so dedupe, cover and ledger read as before (saw ${String(audit.wakeId)})`);
  ok(audit.seatWakeId === FIRE_WAKE, `§3: the worker's audit holds the seat wake as seatWakeId (saw ${String(audit.seatWakeId)})`);
  ok(replyAuditFor(seatCtx("turn-s2"), "tool").seatWakeId === undefined, "§3: a seat's audit holds no seatWakeId");
});

await inWorker(async () => {
  const audit = replyAuditFor(workerCtx("turn-w3"), "tool", "held-wake");
  ok(replyRowWakeId(audit) === "held-wake", `§4: the caller's own wake wins over the seat stamp (saw ${String(replyRowWakeId(audit))})`);
  const id = await postReply({ platform: "slack", channelId: CHAN }, "Held wake answer.", audit);
  ok((await rowFor("reply.post", id))?.wakeId === "held-wake", "§4: the row names the caller's wake");
});

await inWorker(async () => {
  const audit = replyAuditFor(workerCtx("turn-w4"), "tool");
  const id = await postReply({ platform: "slack", channelId: CHAN }, "First draft.", audit);
  await recordOwnPost(ORG, { platform: "slack", channelId: CHAN }, id);
  await editPostedMessage({ platform: "slack", channelId: CHAN }, id, "Second draft.", audit);
  const detail = await rowFor("reply.edit", id);
  ok(detail !== undefined, "§5: the worker's edit writes one reply.edit row");
  ok(detail?.wakeId === FIRE_WAKE, `🔴 §5: the worker's reply.edit row carries the seat wake too (saw ${String(detail?.wakeId)})`);
});

await removeTempDir(dir);
console.log(`✓ worker-reply-wake: ${passed} assertions`);
