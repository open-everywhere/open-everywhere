import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-held-question-")), "ops.sqlite3");
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
const SLACK_KEY = "slack/T_HQ/C_HQ";
overrideSettingsForTest({ window: { topology: true } });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "payments", reach: [SLACK_KEY], ambientSupervisor: true, mode: "unified" }), defineDomain({ name: "org", match: "org" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_HQ" ? ["payments"] : []),
});

const heldQuestion = await import("../agent/access/held-question.js");
const { heldQuestionNonMemberKey, nonMemberAnsweredIds } = heldQuestion;
const { untrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const spawnTaintHook = (await import("../agent/hooks/spawn-taint.js")).default as unknown as {
  events: Record<string, (e: unknown, c: unknown) => unknown>;
};
const heldQuestionHook = (await import("../agent/hooks/held-question.js")).default as unknown as {
  events: Record<string, (e: unknown, c: unknown) => Promise<void>>;
};
const { NONMEMBER_ANSWER_MARKED_AUDIT_ACTION } = await import("../agent/hooks/held-question.js");
const unifiedChannel = (await import("../agent/channels/unified.js")).default as unknown as {
  receive(input: unknown, args: { from: (token: string) => unknown }): Promise<unknown>;
};
const { unifiedSupervisorToken } = await import("../agent/channels/unified-supervisor.js");
const { mintWakeId } = await import("../agent/channels/unified-window.js");

const ORG = "default";

const bagOf = (principal: string, extra: Record<string, string> = {}) => ({
  authenticator: "slack-webhook",
  principalId: principal,
  principalType: "slack-user",
  attributes: { team_id: "T_HQ", channel_id: "C_HQ", user_id: principal, ...extra },
});

function seatCtx(turnId: string) {
  return {
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g1" },
    session: { id: "sess-hq", turn: { id: turnId, sequence: 1 }, auth: { current: bagOf("U_A") } },
    agent: { name: "oe", nodeId: "__root__" },
  } as never;
}

function turnStarted(ctx: never): void {
  spawnTaintHook.events["turn.started"]!({}, ctx);
  spawnTaintHook.events["step.started"]!({}, ctx);
}

const store = getOperationalStore();

const nonMemberRow = async (requestId: string) => store.getTaskResult(ORG, heldQuestionNonMemberKey(requestId));
{
  const seatToken = unifiedSupervisorToken("payments", 1);
  const respondCalls: { options: Record<string, unknown> }[] = [];
  const sends: string[] = [];
  const from = (token: string) => ({
    async respond(_responses: unknown, options: Record<string, unknown>) {
      respondCalls.push({ options });
      return {} as never;
    },
    async send() {
      sends.push(token);
      return {} as never;
    },
  });
  const answerOf = (requestId: string, nonMember: boolean) => ({
    message: "use staging",
    auth: { principalId: "U_GUEST", attributes: { oe_platform: "slack", user_id: "U_GUEST", team_id: "T_HQ", channel_id: "C_HQ", ...(nonMember ? { oe_chat_nonmember: "true" } : {}) } },
    target: {
      token: seatToken,
      wakeId: mintWakeId(),
      surfaceKey: SLACK_KEY,
      origin: { platform: "slack", channelId: "C_HQ", threadTs: "111.1" },
      answer: { requestId, floor: "member", ...(nonMember ? { nonMember: true } : {}) },
    },
  });

  await unifiedChannel.receive(answerOf("q1-guest", true), { from });
  eq(respondCalls.length, 1, "Q1 precondition: the guest's message was delivered as the answer");
  ok(!Object.prototype.hasOwnProperty.call(respondCalls[0]!.options, "auth"), "Q1: …and it still rides NO auth (OPE-2336 kept)");
  ok((await nonMemberRow("q1-guest")) !== null, "🔴 Q1 THE FIX: the guest's nonmember stamp is recorded on the held-question row");

  await unifiedChannel.receive(answerOf("q1-member", false), { from });
  eq(respondCalls.length, 2, "Q1 precondition: the member's message was delivered as the answer");
  eq(await nonMemberRow("q1-member"), null, "Q1 NEGATIVE CONTROL: a member's answer records no stamp");

  let malformed = false;
  try {
    const bad = answerOf("q1-bad", false);
    await unifiedChannel.receive({ ...bad, target: { ...bad.target, answer: { ...bad.target.answer, nonMember: "yes" } } }, { from });
  } catch {
    malformed = true;
  }
  ok(malformed, "Q1: a target whose nonmember flag is not exactly `true` is refused as malformed");

  const real = store.putTaskResult.bind(store);
  (store as { putTaskResult: typeof store.putTaskResult }).putTaskResult = async (org, key, ...rest) => {
    if (key === heldQuestionNonMemberKey("q1-blip")) throw new Error("store blip");
    return real(org, key, ...rest);
  };
  try {
    sends.length = 0;
    await unifiedChannel.receive(answerOf("q1-blip", true), { from });
  } finally {
    (store as { putTaskResult: typeof store.putTaskResult }).putTaskResult = real;
  }
  eq(respondCalls.length, 2, "🔴 Q1 FAIL CLOSED: a guest's answer whose stamp could not be recorded is never delivered as an answer");
  eq(sends.length, 1, "Q1: …it falls through to an ordinary wake, which carries the guest's own stamped bag");
}
{
  const src = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
  ok(
    /answer: authString\(authorityAttributes\[OE_CHAT_NONMEMBER_ATTR\]\) === "true" \? \{ \.\.\.answer, nonMember: true as const \} : answer/u.test(src),
    "Q1: the divert sets `nonMember` from the answering wake's own `oe_chat_nonmember` attribute",
  );
}

const resolved = (kind: string, requestId: string) => ({ data: { resolutions: [{ kind, outcome: "answered", requestId }], sequence: 1, stepIndex: 1, turnId: "t" } });
await contextStorage.run(new ContextContainer(), async () => {
  const ctx = seatCtx("turn_q2");
  turnStarted(ctx);
  ok(!untrustedIngestedThisTurn(), "Q2 precondition: the turn opened clean");
  await heldQuestionHook.events["input.resolved"]!(resolved("question", "q1-member"), ctx);
  ok(!untrustedIngestedThisTurn(), "Q2 NEGATIVE CONTROL: a member's answer leaves the turn clean");
  await heldQuestionHook.events["input.resolved"]!(resolved("tool-approval", "q1-guest"), ctx);
  ok(!untrustedIngestedThisTurn(), "Q2: a resolution that is not a question reads no stamp");
  await heldQuestionHook.events["input.resolved"]!(resolved("question", "q1-guest"), ctx);
  ok(untrustedIngestedThisTurn(), "🔴 Q2 THE FIX: the guest's answer marks the asking turn, as a plain message from that guest would");
});
{
  const rows = await readAudit({ org: ORG, action: NONMEMBER_ANSWER_MARKED_AUDIT_ACTION, limit: 10 });
  eq(rows.length, 1, "Q2: one audit row records the mark");
  eq((rows[0]!.detail as { requestIds?: unknown }).requestIds, ["q1-guest"], "Q2: …naming the request id, and ids only");
  ok(!JSON.stringify(rows[0]).includes("use staging"), "Q2: the answer text is never audited");
}
{
  const throwing = {
    putTaskResult: async () => {
      throw new Error("store down");
    },
    getTaskResult: async () => {
      throw new Error("store down");
    },
  };
  eq(await nonMemberAnsweredIds(throwing, ORG, ["q-x"]), ["q-x"], "Q2 FAIL CLOSED: an unreadable stamp row counts as a guest's answer");
  eq(await nonMemberAnsweredIds(store, ORG, ["q-never"]), [], "Q2: an absent row is a member's answer");
}

{
  const { resetOperationalStore } = await import("../agent/operational/provider.js");
  resetOperationalStore();
  process.env.DATABASE_URL = "postgres://unregistered.invalid/oe";
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      const ctx = seatCtx("turn_q2_nostore");
      turnStarted(ctx);
      ok(!untrustedIngestedThisTurn(), "Q2 precondition: the turn opened clean");
      await heldQuestionHook.events["input.resolved"]!(resolved("tool-approval", "q-nostore"), ctx);
      ok(!untrustedIngestedThisTurn(), "Q2: with no store, a resolution that is not a question still marks nothing");
      await heldQuestionHook.events["input.resolved"]!(resolved("question", "q-nostore"), ctx);
      ok(untrustedIngestedThisTurn(), "🔴 Q2 FAIL CLOSED: a store the hook cannot build marks the turn — 'could not check' is never 'a member answered'");
    });
  } finally {
    delete process.env.DATABASE_URL;
    resetOperationalStore();
  }
}

console.log(`✓ held-question: ${n} assertions passed`);
