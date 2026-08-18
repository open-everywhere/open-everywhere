import { randomBytes } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import {
  afterThisTest,
  bootAgent,
  installLinearApiStub,
  linearAgentSessionPost,
  LINEAR_UNIFIED_ORG_ID,
  LINEAR_UNIFIED_TEAM_ID,
  readAuditRows,
  waitFor,
  type LinearApiCall,
} from "../harness";

afterAll(async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

async function armSeams(authorId: string): Promise<{ readonly calls: readonly LinearApiCall[] }> {
  await bootAgent();
  process.env.LINEAR_APP_USER_ID = "it-linear-app-actor";
  process.env.LINEAR_APP_NAME = "OE Bot";

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ externalPolicy: { authorGrain: "withhold" } });
  expect(settings.getSettings().externalPolicy.authorGrain).toBe("withhold");

  const stub = installLinearApiStub((call) => {
    if (call.operation === "OeAmbientComment" && call.variables.id !== undefined) {
      return {
        data: {
          comment: {
            id: call.variables.id,
            body: "irrelevant — withheld before the model ever sees it",
            createdAt: new Date().toISOString(),
            user: { id: authorId, guest: true },
            issue: { id: "it-linear-issue-1", identifier: "IT-1", title: "fixture issue", team: { id: LINEAR_UNIFIED_TEAM_ID, private: false } },
          },
        },
      };
    }
    if (call.operation === "AgentActivityCreate") {
      return { data: { agentActivityCreate: { success: true, agentActivity: { id: "it-linear-close-activity" } } } };
    }
    return undefined;
  });
  afterThisTest(() => stub.uninstall());
  return stub;
}

test("a signed Linear agent-session delivery is accepted (200) and a refuted author's mention is withheld with its OWN linear.external_policy_suppressed row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const authorId = `it-linear-refuted-${nonce}`;
  const { calls } = await armSeams(authorId);
  const agentSessionId = `it-linear-session-${nonce}`;
  const commentId = `it-linear-comment-${nonce}`;
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const res = await linearAgentSessionPost({
    agentSessionId,
    organizationId: LINEAR_UNIFIED_ORG_ID,
    teamId: LINEAR_UNIFIED_TEAM_ID,
    issueId: "it-linear-issue-1",
    commentId,
  });
  expect(res.status, `the Linear front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);

  const row = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["linear.external_policy_suppressed"], sinceIso });
    return rows.find((r) => r.principalId === authorId);
  }, "the linear.external_policy_suppressed row for this refuted author");

  expect(row.platform).toBe("linear");
  expect(row.workspace).toBe(LINEAR_UNIFIED_ORG_ID);
  expect(row.surface).toBe(`linear/${LINEAR_UNIFIED_ORG_ID}/${LINEAR_UNIFIED_TEAM_ID}`);
  expect(row.detail?.verdict).toBe("withheld-author");

  expect(calls.some((c) => c.operation === "OeAmbientComment")).toBe(true);

  const dispatched = await readAuditRows({ actions: ["linear.dispatched"], sinceIso });
  expect(dispatched.find((r) => r.surface === `linear/${LINEAR_UNIFIED_ORG_ID}/${LINEAR_UNIFIED_TEAM_ID}`)).toBeUndefined();
});

test("an unsigned Linear agent-session delivery is refused (401) and writes NO linear.external_policy_suppressed row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const authorId = `it-linear-unsigned-${nonce}`;
  const { calls } = await armSeams(authorId);
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const res = await linearAgentSessionPost({
    agentSessionId: `it-linear-session-${nonce}`,
    organizationId: LINEAR_UNIFIED_ORG_ID,
    teamId: LINEAR_UNIFIED_TEAM_ID,
    issueId: "it-linear-issue-1",
    commentId: `it-linear-comment-${nonce}`,
    signed: false,
  });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await readAuditRows({ actions: ["linear.external_policy_suppressed"], sinceIso });
  expect(rows.find((r) => r.principalId === authorId)).toBeUndefined();
  expect(calls.length).toBe(0);
});

test("a TAMPERED Linear agent-session delivery (a wrong-but-well-formed signature) is refused (401) and writes NO row", async () => {
  const nonce = randomBytes(6).toString("hex");
  const authorId = `it-linear-tampered-${nonce}`;
  const { calls } = await armSeams(authorId);
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const res = await linearAgentSessionPost({
    agentSessionId: `it-linear-session-${nonce}`,
    organizationId: LINEAR_UNIFIED_ORG_ID,
    teamId: LINEAR_UNIFIED_TEAM_ID,
    issueId: "it-linear-issue-1",
    commentId: `it-linear-comment-${nonce}`,
    signature: "0".repeat(64),
  });
  expect(res.status).toBe(401);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await readAuditRows({ actions: ["linear.external_policy_suppressed"], sinceIso });
  expect(rows.find((r) => r.principalId === authorId)).toBeUndefined();
  expect(calls.length).toBe(0);
});
