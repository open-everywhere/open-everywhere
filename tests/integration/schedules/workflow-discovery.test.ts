import { expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";

import { auditCursor, bootAgent, rowsSinceCursor, runScheduleTask, SLACK_TEAM_ID, type AuditRow } from "../harness";
import { installSlackWebApiStub } from "../slack-web-api";

const PERSON = "U0OPE2512DSC";
const DM = "D0OPE2512DSC";
const DAY_MS = 86_400_000;

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("the compiled personal-watch task offers a routine for repeated work, with no watch source declared", async () => {
  const slack = installSlackWebApiStub((method) => {
    if (method === "users.info") return { ok: true, user: { id: PERSON, team_id: SLACK_TEAM_ID, deleted: false, is_bot: false } };
    if (method === "conversations.open") return { ok: true, channel: { id: DM } };
    if (method === "chat.postMessage") return { ok: true, ts: "1760009420.252000", channel: DM };
    return undefined;
  });
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const org = deploymentOrg();
    const principalKey = `slack/${SLACK_TEAM_ID}/${PERSON}`;
    const { enrollPersonalWatch, readPersonalWatch } = await import("@open-everywhere/core/agent/personal-watch/state.js");
    const { inQuietHours } = await import("@open-everywhere/core/agent/personal-watch/dial.js");
    const store = getOperationalStore();
    const now = Date.now();
    for (const weeks of [1, 2, 3]) {
      await store.appendToolUsage({
        org,
        ts: new Date(now - weeks * 7 * DAY_MS).toISOString(),
        surfaceKey: `slack/${SLACK_TEAM_ID}/${DM}`,
        principalId: PERSON,
        sessionId: `s-ope2512-${weeks}`,
        event: "call",
        tool: "list_issues",
        connector: "linear",
        outcome: "ok",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      });
    }
    expect(await enrollPersonalWatch(org, principalKey), "the person could not be enrolled").toBe("enrolled");
    const cursor = await auditCursor();
    const quiet = inQuietHours(new Date());

    await runScheduleTask("schedules/personal-watch.ts");

    const row = (await readPersonalWatch(org, principalKey)).state;
    expect(row?.lastDiscoveryAt, "🔴 the compiled task never ran workflow discovery for the person").toBeDefined();
    const weekday = new Date(now).getUTCDay();
    const fingerprint = `weekly:linear/list_issues:${weekday}`;
    if (quiet) {
      const rows = await rowsSinceCursor(cursor, ["personal_watch.silence"], { limit: 200 });
      const held = rows.find((r) => r.principalId === principalKey && detailOf(r).fingerprint === fingerprint);
      expect(detailOf(held).reason, "inside the quiet hours the proposal is held, and the hold is filed").toBe("quiet-hours");
      return;
    }
    expect(row?.proposals.map((p) => p.fingerprint), "🔴 the row does not record the proposal").toEqual([fingerprint]);
    const rows = await rowsSinceCursor(cursor, ["personal_watch.proposal", "approval.requested"], { limit: 200 });
    expect(rows.some((r) => r.action === "personal_watch.proposal" && r.principalId === principalKey), "no personal_watch.proposal row").toBe(true);
    const posts = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === DM);
    expect(posts.length, "🔴 no card was posted into the person's DM — the kind is not registered on the host, or the post failed").toBe(1);
    const blocks = JSON.stringify(JSON.parse(posts[0]!.params.get("blocks") ?? "[]"));
    expect(blocks, "the card has no Set it up button").toContain('"Set it up"');
    expect(blocks, "the card has no No thanks button").toContain('"No thanks"');
    expect(blocks, "the card leaks the fingerprint").not.toContain("weekly:");
  } finally {
    slack.uninstall();
  }
});
