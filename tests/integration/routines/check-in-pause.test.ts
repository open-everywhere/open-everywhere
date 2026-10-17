import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import { auditCursor, bootAgent, rowsSinceCursor, runRoutineDispatchTick, type AuditRow } from "../harness";
import { installSlackWebApiStub } from "../slack-web-api";

const TEAM = "T0EXAMPLE";
const CHANNEL = "C0EXCHAN003";
const SURFACE_KEY = `slack/${TEAM}/${CHANNEL}`;
const CREATOR = "slack:U0OPE2511CRT";

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

test("a routine past its check-in grace pauses on the compiled dispatcher tick and posts a Resume card", async () => {
  const slack = installSlackWebApiStub((method) => (method === "chat.postMessage" ? { ok: true, ts: "1760009420.251000", channel: CHANNEL } : undefined));
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  try {
    const cursor = await auditCursor();
    const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
    const id = `r-it-2511-${randomBytes(4).toString("hex")}`;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await addRoutine(
      { org: "default", platform: "slack", workspace: TEAM, surface: CHANNEL, workspaceKey: `slack/${TEAM}`, surfaceKey: SURFACE_KEY, domainKey: SURFACE_KEY, key: SURFACE_KEY },
      {
        id,
        org: "default",
        surfaceKey: SURFACE_KEY,
        target: { channelId: CHANNEL },
        trigger: { kind: "interval", everyMinutes: 60 },
        prompt: "ope2511 post the open incident count",
        createdBy: CREATOR,
        status: "active",
        nextRunAt: dueAt,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        promptGeneration: 1,
        consecutiveFailures: 0,
        attention: { runs: 124, warnedAtRun: 100, cardId: "ope2511-earlier-card" },
      },
    );

    await runRoutineDispatchTick();

    const paused = await getRoutine("default", SURFACE_KEY, id);
    expect(paused?.status, "🔴 the routine past its grace was not paused — the compiled dispatcher did not reach the check-in").toBe("disabled");
    expect(paused?.nextRunAt, "a paused routine still has a next run").toBeNull();
    expect(typeof paused?.attention?.pausedAt, "the row does not record the check-in pause").toBe("string");
    expect(paused?.attention?.cardId, "🔴 no Resume card became the routine's live card — the kind is not registered on the host, or the post failed").not.toBe("ope2511-earlier-card");

    const rows = await rowsSinceCursor(cursor, ["routine.disabled", "approval.requested", "work.forwarded"], { limit: 200 });
    const disabled = rows.find((r) => r.action === "routine.disabled" && detailOf(r).routineId === id);
    expect(detailOf(disabled).checkIn, "the routine.disabled row is not marked as a check-in pause").toBe(true);
    expect(
      rows.some((r) => r.action === "work.forwarded" && detailOf(r).routineId === id),
      "🔴 the paused routine still fired",
    ).toBe(false);

    const posts = slack.calls.filter((c) => c.method === "chat.postMessage" && c.params.get("channel") === CHANNEL);
    expect(posts.length, "no card was posted into the routine's channel").toBe(1);
    const blocks = JSON.stringify(JSON.parse(posts[0]!.params.get("blocks") ?? "[]"));
    expect(blocks, "the pause card has no Resume button").toContain('"Resume"');
    expect(blocks, "the pause card leaks the routine id").not.toContain(id);
  } finally {
    slack.uninstall();
  }
});
