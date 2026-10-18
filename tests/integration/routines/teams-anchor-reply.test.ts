import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { auditCursor, bootAgent, disposeLater, registerScript, rowsSinceCursor, runRoutineDispatchTick, waitFor, type AuditRow } from "../harness";
import { installHostFetchStub, type HostFetchStub } from "../fetch-stub";

const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const TENANT = "it-ope2568-tenant";
const CREATOR = "29:it-ope2568-creator";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

interface TeamsPost {
  readonly conversationId: string;
  readonly replyTo: string | undefined;
  readonly text: string;
  readonly id: string;
}

function installTeamsConnectorStub(): { readonly posts: TeamsPost[] } {
  const prior = process.env.MICROSOFT_APP_PASSWORD;
  process.env.MICROSOFT_APP_PASSWORD = "it-fixture-password-not-a-secret";
  const posts: TeamsPost[] = [];
  let seq = 0;
  const login: HostFetchStub = installHostFetchStub("https://login.microsoftonline.com/", () =>
    Response.json({ access_token: "it-fixture-token", token_type: "Bearer", expires_in: 3600 }),
  );
  const connector: HostFetchStub = installHostFetchStub(SERVICE_URL, (url, init) => {
    const m = /\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/u.exec(url.pathname);
    if (m === null || (init?.method ?? "POST").toUpperCase() !== "POST") return Response.json({}, { status: 200 });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: unknown; type?: unknown }) : {};
    if (body.type === "typing") return Response.json({}, { status: 200 });
    const id = `it-ope2568-activity-${++seq}`;
    posts.push({ conversationId: decodeURIComponent(m[1]!), replyTo: m[2] === undefined ? undefined : decodeURIComponent(m[2]), text: String(body.text ?? ""), id });
    return Response.json({ id });
  });
  disposeLater({
    dispose: () => {
      connector.uninstall();
      login.uninstall();
      if (prior === undefined) delete process.env.MICROSOFT_APP_PASSWORD;
      else process.env.MICROSOFT_APP_PASSWORD = prior;
    },
  });
  return { posts };
}

async function seedTeamsRoutine(input: { readonly nonce: string; readonly sessionMode?: "job"; readonly due: boolean; readonly testId?: string }): Promise<{ id: string; surfaceKey: string; base: string; conv: string; nextRunAt: string }> {
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const base = `19:it-ope2568-${input.nonce}@thread.tacv2`;
  const conv = `${base};messageid=1700000000333`;
  const surface = `19_it-ope2568-${input.nonce}_thread.tacv2_messageid_1700000000333`;
  const surfaceKey = `teams/${TENANT}/${surface}`;
  const id = `r-it-2568-${randomBytes(4).toString("hex")}`;
  const nextRunAt = input.due ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
  await addRoutine(
    { org: "default", platform: "teams", workspace: TENANT, surface, workspaceKey: `teams/${TENANT}`, surfaceKey, domainKey: surfaceKey, key: surfaceKey },
    {
      id,
      org: "default",
      surfaceKey,
      target: { serviceUrl: SERVICE_URL, conversationId: conv, conversationType: "channel", tenantId: TENANT },
      trigger: { kind: "interval", everyMinutes: 60 },
      prompt: "ope2568 post the open incident count",
      createdBy: CREATOR,
      status: "active",
      nextRunAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      promptGeneration: 1,
      consecutiveFailures: 0,
      ...(input.sessionMode !== undefined ? { sessionMode: input.sessionMode } : {}),
      ...(input.testId !== undefined ? { testRun: { id: input.testId, requestedBy: CREATOR, requestedAt: new Date().toISOString() } } : {}),
    },
  );
  return { id, surfaceKey, base, conv, nextRunAt };
}

test("a Teams test run's answer replies to the test's opening post, not into the routine's own chain", async () => {
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const teams = installTeamsConnectorStub();
  const ANSWER = "ope2568 test answer: 3 incidents open";
  disposeLater(registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: ANSWER }, id: "ope2568-test-reply" }] }, { say: "ok" }] }));
  const cursor = await auditCursor();
  const testId = `t-${randomBytes(4).toString("hex")}`;
  const r = await seedTeamsRoutine({ nonce: randomBytes(3).toString("hex"), due: false, testId });

  await runRoutineDispatchTick();

  const fired = await waitFor(async () => (await rowsSinceCursor(cursor, ["routine.test_fired"], { limit: 100 })).find((row) => detailOf(row).test === testId), "the routine.test_fired row");
  expect(detailOf(fired).started, `🔴 the Teams test did not start (${String(detailOf(fired).reason)})`).toBe(true);
  const root = teams.posts.find((p) => p.text.startsWith("🧪 Test run of"));
  expect(root, "🔴 no opening post was posted").toBeDefined();
  expect([root!.conversationId, root!.replyTo], "the opening post did not open a chain of its own in the channel").toEqual([r.base, undefined]);

  const answer = await waitFor(async () => teams.posts.find((p) => p.text.includes(ANSWER)), "the run's answer on the Connector", 150_000);
  expect([answer.conversationId, answer.replyTo], "🔴 the run's answer did not reply to the opening post").toEqual([r.base, root!.id]);
  expect(teams.posts.some((p) => p.conversationId === r.conv), "🔴 something posted into the routine's own reply chain").toBe(false);
});

test("a Teams durable job posts a kickoff, keys on it, and answers under it", async () => {
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const teams = installTeamsConnectorStub();
  const ANSWER = "ope2568 job answer: still waiting on review";
  disposeLater(registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: ANSWER }, id: "ope2568-job-reply" }] }, { say: "ok" }] }));
  const r = await seedTeamsRoutine({ nonce: randomBytes(3).toString("hex"), due: true, sessionMode: "job" });

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length, "🔴 the job did not fire").toBeGreaterThan(0);

  const kickoff = teams.posts.find((p) => p.text.startsWith("🔄 Starting job"));
  expect(kickoff, "🔴 the job posted no kickoff (today's code: Slack-only session join)").toBeDefined();
  expect([kickoff!.conversationId, kickoff!.replyTo], "the kickoff did not open a chain of its own in the channel").toEqual([r.base, undefined]);
  const { getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  expect((await getRoutine("default", r.surfaceKey, r.id))?.jobSessionAnchor, "🔴 the kickoff is not stored as the job's anchor").toBe(kickoff!.id);

  const answer = await waitFor(async () => teams.posts.find((p) => p.text.includes(ANSWER)), "the job's answer on the Connector", 150_000);
  expect([answer.conversationId, answer.replyTo], "🔴 the job's answer did not reply to its kickoff post").toEqual([r.base, kickoff!.id]);
});
