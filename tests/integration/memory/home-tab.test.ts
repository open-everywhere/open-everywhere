import { afterAll, expect, test } from "vitest";

import { auditCursor, bootAgent, installSlackWebApiStub, rowsSinceCursor, SLACK_TEAM_ID, slackInteractivityPost, waitFor, type SlackWebApiStub } from "../harness";

const PERSON = "U0OPE2451HOME";
const PERSON_DM = "D0OPE2451HOME";

const isPerson = (principalId: string | undefined): boolean => principalId === PERSON || principalId?.endsWith(`/${PERSON}`) === true;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

async function armSeams(): Promise<SlackWebApiStub> {
  await bootAgent();
  const stub = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "conversations.open":
        return params.get("users") === PERSON ? { ok: true, channel: { id: PERSON_DM } } : { ok: false, error: "user_not_found" };
      case "users.info":
        return { ok: true, user: { id: PERSON, team_id: SLACK_TEAM_ID, name: "home", profile: { display_name: "home" } } };
      case "users.conversations":
        return { ok: true, channels: [] };
      case "views.publish":
        return { ok: true, view: { id: "V0HOME" } };
      case "files.getUploadURLExternal":
        return { ok: true, upload_url: "https://slack.com/api/__oe_upload", file_id: "F0EXPORT" };
      case "__oe_upload":
        return { ok: true };
      case "files.completeUploadExternal":
        return { ok: true, files: [{ id: "F0EXPORT" }] };
      default:
        return undefined;
    }
  });
  cleanups.push(() => stub.uninstall());
  return stub;
}

function click(action: string): Record<string, unknown> {
  return {
    type: "block_actions",
    user: { id: PERSON, team_id: SLACK_TEAM_ID },
    team: { id: SLACK_TEAM_ID },
    trigger_id: "0.oe-it",
    container: { type: "view", view_id: "V0HOME" },
    actions: [{ type: "button", action_id: `oe_home:${action}`, block_id: "it" }],
  };
}

test("a signed Home-tab Export click builds the person's page and hands them their memory, audited", async () => {
  const stub = await armSeams();
  const cursor = await auditCursor();

  const res = await slackInteractivityPost(click("memory.export"));
  expect(res.status).toBe(200);

  const published = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["home.publish"])).find((r) => isPerson(r.principalId) && r.detail?.["ok"] === true),
    "the person's home.publish row",
    120_000,
  );
  expect(published.detail?.["notice"]).toBe(true);

  const exported = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["memory.export"])).find((r) => isPerson(r.principalId)),
    "the person's memory.export row",
    120_000,
  );
  expect(exported.detail?.["via"]).toBe("slack-app-home");
  expect(typeof exported.detail?.["sha256"]).toBe("string");

  const methods = stub.calls.map((c) => c.method);
  expect(methods).toContain("files.completeUploadExternal");
  const complete = stub.calls.find((c) => c.method === "files.completeUploadExternal")!;
  expect(complete.params.get("channel_id")).toBe(PERSON_DM);
  const publish = stub.calls.find((c) => c.method === "views.publish")!;
  expect(publish.params.get("user_id")).toBe(PERSON);
});

test("a forged Forget naming a line the person does not hold is answered and erases nothing", async () => {
  await armSeams();
  const cursor = await auditCursor();
  const res = await slackInteractivityPost({
    type: "view_submission",
    user: { id: PERSON, team_id: SLACK_TEAM_ID },
    team: { id: SLACK_TEAM_ID },
    view: { id: "V0MODAL", type: "modal", callback_id: "oe_home_action", private_metadata: `memory.forget|${"0".repeat(64)}`, state: { values: {} } },
  });
  expect(res.status).toBe(200);
  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["home.publish"])).find((r) => isPerson(r.principalId) && r.detail?.["notice"] === true),
    "the republish after the forged Forget",
    120_000,
  );
  const purges = await rowsSinceCursor(cursor, ["memory.purge"]);
  expect(purges.filter((r) => isPerson(r.principalId))).toHaveLength(0);
});
