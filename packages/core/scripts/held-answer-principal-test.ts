import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-held-answer-principal-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

const stubs = await import("./_slack-test-stubs.js");
stubs.registerSlackFixtureMapper();
stubs.registerSlackFixtureCodec();

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
const SLACK_KEY = "slack/T_HA/C_HA";
overrideSettingsForTest({ window: { topology: true } });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: [SLACK_KEY], ambientSupervisor: true, mode: "unified" }), defineDomain({ name: "org", match: "org" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_HA" ? ["payments"] : []),
});

const unifiedChannel = (await import("../agent/channels/unified.js")).default as unknown as {
  receive(input: unknown, args: { from: (token: string) => unknown }): Promise<unknown>;
};
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { mintWakeId } = await import("../agent/channels/unified-window.js");
const { liveAuthIsAnotherPrincipal, noteTurnOpeningPrincipal } = await import("../agent/access/turn-opening-principal.js");
const { adminStandingSubject } = await import("../agent/access/admin-standing.js");
const { recordRequesterIdentity } = await import("../agent/access/requester-identity.js");
const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
const { bindFrom } = await import("../agent/identity/binding.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const spawnTaintHook = (await import("../agent/hooks/spawn-taint.js")).default as unknown as {
  events: Record<string, (e: unknown, c: unknown) => unknown>;
};

const ORG = "default";
const A = { principal: "U_A", deliveryId: "dlv-A-0001" };
const B = { principal: "U_B", deliveryId: "dlv-B-0002" };

{
  const seatToken = unifiedSupervisorToken("payments", 1);
  const respondCalls: string[] = [];
  const sends: string[] = [];
  const from = (token: string) => ({
    async respond() {
      respondCalls.push(token);
      return {} as never;
    },
    async send() {
      sends.push(token);
      return {} as never;
    },
  });
  await unifiedChannel.receive(
    {
      message: "use staging",
      auth: { principalId: B.principal, attributes: { oe_platform: "slack", user_id: B.principal, team_id: "T_HA", channel_id: "C_HA" } },
      target: {
        token: seatToken,
        wakeId: mintWakeId(),
        surfaceKey: SLACK_KEY,
        origin: { platform: "slack", channelId: "C_HA", threadTs: "111.1" },
        answer: { requestId: "req-held-1", floor: "member" },
      },
    },
    { from },
  );
  eq(respondCalls.length, 0, "🔴 H1: a target that names an answer delivers NO respond — the unified channel has no answer road (OPE-2389)");
  eq(sends, [seatToken], "H1: …it is one ordinary send to the seat, as every room message is");
}

function seatCtx(turnId: string, who: { principal: string; deliveryId: string }) {
  return {
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g1" },
    session: {
      id: "sess-held-answer",
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: {
            oe_platform: "slack",
            oe_grain: "standing",
            oe_window_token: "oe-dom:payments:oe-sup:g1",
            oe_delivery_id: who.deliveryId,
            team_id: "T_HA",
            channel_id: "C_HA",
            user_id: who.principal,
          },
          principalId: who.principal,
          principalType: "slack-user",
        },
      },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as never;
}

function turnStarted(ctx: never): void {
  spawnTaintHook.events["turn.started"]!({}, ctx);
  spawnTaintHook.events["step.started"]!({}, ctx);
}

const askBy = (authorId: string): string =>
  renderWakeEnvelope({
    reason: "mention",
    currentTime: "2026-04-28T20:27:00.000Z",
    channel: { id: "C_HA" },
    messages: [{ trigger: true, from: "human", trust: "peer", author: authorId, authorId, body: "run the admin listing", sentAt: "2026-04-28T20:27:00.000Z", id: "1776325400.000001" }],
  });

await contextStorage.run(new ContextContainer(), async () => {
  turnStarted(seatCtx("turn_h2", A));
  eq(liveAuthIsAnotherPrincipal(seatCtx("turn_h2", A) as never), false, "H2: the opener's own bag is not a swap");
  eq(liveAuthIsAnotherPrincipal(seatCtx("turn_h2", { principal: A.principal, deliveryId: "dlv-A-0009" }) as never), false, "H2: a later delivery by the SAME person is not a swap");
  eq(liveAuthIsAnotherPrincipal(seatCtx("turn_h2", B) as never), true, "🔴 H2: B's bag inside A's turn IS a swap");
  eq(liveAuthIsAnotherPrincipal(seatCtx("turn_other", B) as never), false, "H2: …and only for the turn the record placed");
  const child = { ...(seatCtx("turn_h2c", A) as object), session: { ...((seatCtx("turn_h2c", A) as { session: object }).session), parent: { sessionId: "sess-parent", callId: "call-1" } } } as never;
  noteTurnOpeningPrincipal(child);
  eq(liveAuthIsAnotherPrincipal(seatCtx("turn_h2c", B) as never), false, "H2: a child turn records nothing");
});
eq(liveAuthIsAnotherPrincipal(seatCtx("turn_h2", B) as never), false, "H2: outside an eve context the read answers false and never throws");

await contextStorage.run(new ContextContainer(), async () => {
  const ctxA = seatCtx("turn_h3", A);
  turnStarted(ctxA);
  recordRequesterIdentity(ctxA as never, "turn_h3", askBy(A.principal));
  const own = adminStandingSubject(bindFrom(ctxA as never), ctxA as never);
  eq(own, { ok: true, principalId: A.principal }, "H3: with no swap the subject is A — the person whose own ask opened the turn");

  const ctxB = seatCtx("turn_h3", B);
  const swapped = adminStandingSubject(bindFrom(ctxB as never), ctxB as never);
  eq(swapped.ok, false, "🔴 H3 THE FIX: after B's answer swapped the bag, the gate refuses — it never serves A's standing under B's presence");
  ok(!swapped.ok && /different person's identity/.test(swapped.message), "H3: …and the refusal names the swap, not a missing record");
  ok(!swapped.ok && !/not an admin/i.test(swapped.message), "H3: …and it never says 'you are not an admin'");
});
await contextStorage.run(new ContextContainer(), async () => {
  const ctxB = seatCtx("turn_h3b", B);
  turnStarted(ctxB);
  recordRequesterIdentity(ctxB as never, "turn_h3b", askBy(B.principal));
  eq(adminStandingSubject(bindFrom(ctxB as never), ctxB as never), { ok: true, principalId: B.principal }, "H3 control: on B's own turn the subject is B");
});

function nativeCtx(turnId: string, who: { principal: string }) {
  return {
    channel: { kind: "slack" },
    session: {
      id: "sess-native",
      turn: { id: turnId, sequence: 1 },
      auth: { current: { attributes: { team_id: "T_HA", channel_id: "C_HA", user_id: who.principal, trust_checked: "true" }, principalId: who.principal, principalType: "slack-user" } },
    },
    agent: { name: "oe", nodeId: "__root__" },
  } as never;
}
const delegatedRow = async (callId: string): Promise<{ binding?: { principalId?: string }; requester?: unknown } | null> => {
  const raw = await getOperationalStore().getTaskResult(ORG, `oe-delegated-task-wake:sess-native:${callId}`);
  return raw === null ? null : (JSON.parse(raw) as { binding?: { principalId?: string }; requester?: unknown });
};
const delegate = (callId: string) => ({ data: { actions: [{ kind: "tool-call", toolName: "agent", callId, input: { message: "list it" } }] } });
await contextStorage.run(new ContextContainer(), async () => {
  const ctxA = nativeCtx("turn_h4", A);
  turnStarted(ctxA);
  recordRequesterIdentity(ctxA as never, "turn_h4", askBy(A.principal));
  await spawnTaintHook.events["actions.requested"]!(delegate("call-own"), ctxA);
  const own = await delegatedRow("call-own");
  eq(own?.binding?.principalId, A.principal, "H4: with no swap the binding names A");
  eq(own?.requester, { kind: "requester", principalId: A.principal }, "H4: …and the requester names A — both halves from A's own act");

  await spawnTaintHook.events["actions.requested"]!(delegate("call-swapped"), nativeCtx("turn_h4", B));
  eq(await delegatedRow("call-swapped"), null, "🔴 H4 THE FIX: after a swap NO row binds B's live identity to A's ask — the child resolves no authority and fails closed");
});

{
  const src = readFileSync(new URL("../agent/tools/spawn_thread_session.ts", import.meta.url), "utf8");
  const guardBlock = /if \(liveAuthIsAnotherPrincipal\(c\)\) \{\s*throw new Error\(/u.exec(src);
  const dispatch = src.indexOf("dispatchTaskWindow({");
  ok(guardBlock !== null, "H5: spawn_thread_session tests ITS OWN context `c` for a swap and throws on one");
  ok(guardBlock !== null && dispatch > guardBlock.index, "H5: …BEFORE it builds the dispatch that forwards the bag");
  const c = /const c = ctx as BindableContext;/u.exec(src);
  ok(c !== null && c.index < (guardBlock?.index ?? 0), "H5: …and `c` is the execute's own context");
}

console.log(`✓ held-answer-principal: ${n} assertions passed`);
