import { expect, test } from "vitest";
import {
  afterThisTest,
  auditCursor,
  bootAgent,
  discordMentionWake,
  disposeLater,
  registerScript,
  seatReply,
  rowsSinceCursor,
  runRoutineDispatchTick,
  seedDueRoutine,
  waitFor,
  type AuditRow,
  type ScriptedHandle,
  type SeatScript,
} from "./harness";

const CREATOR = "U0FIRECREATOR";
const TEAM = "T0ITFIRE";
const CHANNEL = "C0ITFIRE";
const DISCORD_UNLISTED = "9000000000000000777";
const BRIDGE_CHANNEL = "C0EXCHAN003";

function isBridgeSurfaceFor(surface: string | undefined, channel: string): boolean {
  return typeof surface === "string" && surface.includes(channel);
}

function proposeSpendLimit(): SeatScript {
  return {
    parent: [
      { calls: [{ tool: "set_spend_limit", input: { monthlyUsd: 12.5, reason: "OPE-483 carriage probe" } }] },
      { say: "ok" },
    ],
  };
}

function spendLimitResult(handle: ScriptedHandle): { isError: boolean; output: unknown } | undefined {
  for (const req of handle.requests) {
    const hit = req.toolResults.find((t) => t.name === "set_spend_limit");
    if (hit) return { isError: hit.isError, output: hit.output };
  }
  return undefined;
}

function chainRowFor(rows: readonly AuditRow[], tool: string): AuditRow | undefined {
  return rows.find((r) => (r.detail as { tool?: string } | undefined)?.tool === tool);
}

test("a REAL routine fire arrives with NO acting sender — the presence fence refuses its proposal", async () => {
  await bootAgent({ sharedSqlite: true });
  const handle = disposeLater(registerScript(proposeSpendLimit()));
  const cursor = await auditCursor();

  const routineId = await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "check the spend cap and raise it if it is too low",
    createdBy: CREATOR,
  });
  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length).toBeGreaterThan(0);

  const result = await waitFor(() => spendLimitResult(handle), "the fire's set_spend_limit call to return", 150_000);

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.output)).toContain("no acting sender");

  const requested = await rowsSinceCursor(cursor, ["approval.requested"]);
  expect(requested.find((r) => r.surface === CHANNEL)).toBeUndefined();

  expect(routineId).toMatch(/^r-it-/);
});

test("the fired session binds as its routine's ATTESTED creator", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));
  const cursor = await auditCursor();

  await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say nothing",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const started = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["egress.policy"])).find((r) => r.surface === CHANNEL),
    "a session.started egress.policy row for the fire",
    150_000,
  );
  expect(started.principalId).toBe(CREATOR);
  expect(started.principalId).not.toBe("eve:app");
});

test("a routine fire that ends in PROSE on the per-surface path is DROPPED — no reply.post row, one drop row", async () => {
  await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  afterThisTest(() => settings.overrideSettingsForTest({ window: { topology: topologyBefore } }));
  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);
  const sayText = "oe-660 terminal route fire reply";
  disposeLater(registerScript({ parent: [{ say: sayText }] }));
  const cursor = await auditCursor();

  await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say something short",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const dropped = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.supervisor_prose_dropped"]);
    return rows.find((r) => r.detail?.chars === sayText.length && r.surface === CHANNEL);
  }, "the routine fire's closing-prose drop row (per-surface path)", 150_000);

  expect(dropped.platform).toBe("slack");
  const posts = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.surface === CHANNEL);
  expect(posts).toEqual([]);
});

test("a routine fire's reply.post row keeps the schedule app as AUTHOR and adds the creator to DETAIL — tool route on a windowed seat", async () => {
  await bootAgent({ sharedSqlite: true });
  const sayText = "oe-660 windowed fire reply through the tool, deliberately longer";
  disposeLater(registerScript({ parent: [seatReply(sayText, "oe660-window"), { say: "NO_REPLY" }] }));
  const cursor = await auditCursor();

  await seedDueRoutine({
    surfaceKey: `slack/T0EXAMPLE/${BRIDGE_CHANNEL}`,
    channelId: BRIDGE_CHANNEL,
    prompt: "say something short",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const reply = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => r.detail?.chars === sayText.length && isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL));
  }, "the routine fire's reply.post row (tool route, on the windowed channel)", 150_000);

  expect(reply.detail?.route).toBe("tool");
  expect(reply.principalId).toBe("eve:app");
  expect(reply.detail?.creatorId).toBe(CREATOR);
});

test("OPE-702 — a chars-only reply.post match is ambiguous across channels; surface scoping resolves it", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();

  const decoyCore = "oe-702 decoy (unlisted channel, fired first)";
  const realCore = "oe-702 real reply (listed channel, fired second)";
  const padLen = Math.max(decoyCore.length, realCore.length) + 3;
  const decoyText = decoyCore.padEnd(padLen, ".");
  const realText = realCore.padEnd(padLen, ".");
  expect(decoyText.length).toBe(realText.length);

  const decoyHandle = registerScript({ parent: [seatReply(decoyText, "oe702-decoy"), { say: "NO_REPLY" }] });
  await seedDueRoutine({ surfaceKey: `slack/${TEAM}/${CHANNEL}`, channelId: CHANNEL, prompt: "say something", createdBy: CREATOR });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);
  const decoyRow = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => isBridgeSurfaceFor(r.surface, CHANNEL) && r.detail?.chars === decoyText.length);
  }, "the decoy fire's reply.post row on its own channel", 150_000);
  expect(decoyRow.detail?.route).toBe("tool");
  decoyHandle.dispose();

  disposeLater(registerScript({ parent: [seatReply(realText, "oe702-real"), { say: "NO_REPLY" }] }));
  await seedDueRoutine({
    surfaceKey: `slack/T0EXAMPLE/${BRIDGE_CHANNEL}`,
    channelId: BRIDGE_CHANNEL,
    prompt: "say something",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);
  const realRow = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((r) => isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL) && r.detail?.chars === realText.length);
  }, "the real windowed fire's reply.post row", 150_000);
  expect(realRow.detail?.route).toBe("tool");

  const allRows = await rowsSinceCursor(cursor, ["reply.post"]);
  const chansOnlyMatches = allRows.filter((r) => r.detail?.chars === realText.length);
  expect(chansOnlyMatches.length).toBeGreaterThanOrEqual(2);
  expect(chansOnlyMatches.some((r) => isBridgeSurfaceFor(r.surface, CHANNEL) && r.detail?.route === "tool")).toBe(true);
  expect(chansOnlyMatches.some((r) => isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL) && r.detail?.route === "tool")).toBe(true);

  const scoped = allRows.find((r) => isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL) && r.detail?.chars === realText.length);
  expect(scoped?.detail?.route).toBe("tool");
});

test("NEGATIVE CONTROL — an ATTENDED wake proposing the same verb passes the fence and cards, unattended:false", async () => {
  await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  afterThisTest(() => settings.overrideSettingsForTest({ window: { topology: topologyBefore } }));
  settings.overrideSettingsForTest({ window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);
  disposeLater(registerScript(proposeSpendLimit()));
  const cursor = await auditCursor();

  await discordMentionWake({ channelId: DISCORD_UNLISTED, text: `<@9000000000000000001> please raise the monthly cap` });

  const chain = await waitFor(
    async () => chainRowFor(await rowsSinceCursor(cursor, ["approval.chain"]), "set_spend_limit"),
    "an approval.chain row for the human's set_spend_limit proposal",
    150_000,
  );
  const detail = chain.detail as { unattended?: unknown; verdict?: unknown; transforms?: readonly { reason?: string }[] };
  expect(detail.unattended).toBe(false);
  expect(detail.verdict).toBe("ask");
  expect((detail.transforms ?? []).map((t) => t.reason)).not.toContain("ask-unattended");
});

const FIRE_STAMPS = ["oe_fire_unattended", "oe_fire_principal"] as const;

function keysOf(row: AuditRow): readonly string[] {
  return ((row.detail as { attrKeys?: readonly string[] }).attrKeys ?? []) as readonly string[];
}

test("the carriage probe records the SAME key set on both sides of the session hop", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript({ parent: [{ say: "carriage probe" }] }));
  const cursor = await auditCursor();

  const routineId = await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say something short",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const sent = await waitFor(
    async () =>
      (await rowsSinceCursor(cursor, ["routine.fire_attrs_sent"])).find(
        (r) => (r.detail as { routineId?: string }).routineId === routineId,
      ),
    `a routine.fire_attrs_sent row for ${routineId}`,
    150_000,
  );
  const seen = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["routine.fire_attrs_seen"])).find((r) => r.surface === CHANNEL),
    "a routine.fire_attrs_seen row for the fired session",
    150_000,
  );

  for (const stamp of FIRE_STAMPS) expect(keysOf(sent)).toContain(stamp);

  for (const k of keysOf(sent)) expect(keysOf(seen)).toContain(k);

  const TURN_BOUNDARY_ATTRS = ["oe_dispatch_turn", "oe_parent_turn_tainted"];
  const DIVERT_ATTRS = ["oe_addressing", "oe_delivery_id", "oe_grain", "oe_platform", "oe_requester", "oe_sources", "oe_wake_id", "oe_window_token"];
  const unexplained = keysOf(seen).filter((k) => !keysOf(sent).includes(k) && !TURN_BOUNDARY_ATTRS.includes(k) && !DIVERT_ATTRS.includes(k));
  expect(unexplained, "the fired session's auth bag grew a key neither the fire nor the host boundary explains").toEqual([]);

  for (const row of [sent, seen]) {
    expect(keysOf(row)).not.toContain(CREATOR);
    expect(keysOf(row)).not.toContain(CHANNEL);
    expect(keysOf(row)).not.toContain(TEAM);
    expect(JSON.stringify(row.detail)).not.toContain(CREATOR);
  }
});

test("the schedule-auth constants the SEEN row keys on still match eve's own", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "node_modules", "eve", "dist", "src", "channel", "schedule-auth.js"), "utf8");
  const { SCHEDULE_APP_AUTHENTICATOR, SCHEDULE_APP_PRINCIPAL_ID, SCHEDULE_APP_PRINCIPAL_TYPE } = await import(
    "@open-everywhere/core/agent/identity/binding.js"
  );
  expect(src).toContain("SCHEDULE_APP_AUTH");
  for (const literal of [SCHEDULE_APP_AUTHENTICATOR, SCHEDULE_APP_PRINCIPAL_ID, SCHEDULE_APP_PRINCIPAL_TYPE]) {
    expect(src).toContain(`\`${literal}\``);
  }
});
