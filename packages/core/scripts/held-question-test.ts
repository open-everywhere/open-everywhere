import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const settlementHook = (await import("../agent/hooks/delegation-settlement.js")).default as unknown as {
  events: Record<string, (e: unknown, c: unknown) => unknown>;
};
const heldQuestionHook = (await import("../agent/hooks/held-question.js")).default as unknown as {
  events: Record<string, (e: unknown, c: unknown) => Promise<void>>;
};
const { NONMEMBER_ANSWER_MARKED_AUDIT_ACTION } = await import("../agent/hooks/held-question.js");

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
  settlementHook.events["turn.started"]!({}, ctx);
  settlementHook.events["step.started"]!({}, ctx);
}

const store = getOperationalStore();

ok(await heldQuestion.rememberNonMemberAnswer(store, ORG, "q1-guest"), "Q1 fixture: the guest's nonmember stamp is recorded through `rememberNonMemberAnswer`");
ok((await store.getTaskResult(ORG, heldQuestionNonMemberKey("q1-guest"))) !== null, "Q1 fixture: …under the held-question key");

const resolved = (kind: string, requestId: string) => ({ data: { resolutions: [{ kind, outcome: "answered", requestId }], sequence: 1, stepIndex: 1, turnId: "t" } });
await contextStorage.run(new ContextContainer(), async () => {
  const ctx = seatCtx("turn_q2");
  turnStarted(ctx);
  const rowsNow = async (): Promise<number> => (await readAudit({ org: ORG, action: NONMEMBER_ANSWER_MARKED_AUDIT_ACTION, limit: 10 })).length;
  await heldQuestionHook.events["input.resolved"]!(resolved("question", "q1-member"), ctx);
  eq(await rowsNow(), 0, "Q2 NEGATIVE CONTROL: a member's answer writes no row");
  await heldQuestionHook.events["input.resolved"]!(resolved("tool-approval", "q1-guest"), ctx);
  eq(await rowsNow(), 0, "Q2: a resolution that is not a question reads no stamp");
  await heldQuestionHook.events["input.resolved"]!(resolved("question", "q1-guest"), ctx);
  eq(await rowsNow(), 1, "🔴 Q2: the guest's answer writes the row");
});
{
  const rows = await readAudit({ org: ORG, action: NONMEMBER_ANSWER_MARKED_AUDIT_ACTION, limit: 10 });
  eq(rows.length, 1, "Q2: one audit row records the guest's answer");
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
      await heldQuestionHook.events["input.resolved"]!(resolved("tool-approval", "q-nostore"), ctx);
      let threw = false;
      try {
        await heldQuestionHook.events["input.resolved"]!(resolved("question", "q-nostore"), ctx);
      } catch {
        threw = true;
      }
      ok(!threw, "Q2: a store the hook cannot build never fails the resolution");
    });
  } finally {
    delete process.env.DATABASE_URL;
    resetOperationalStore();
  }
}

console.log(`✓ held-question: ${n} assertions passed`);
