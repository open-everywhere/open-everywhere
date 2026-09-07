import { expect, test } from "vitest";
import {
  disposeLater,
  bootAgent,
  discordMentionWake,
  readAuditRows,
  registerScript,
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
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

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

  const requested = await readAuditRows({ actions: ["approval.requested"], sinceIso });
  expect(requested.find((r) => r.surface === CHANNEL)).toBeUndefined();

  expect(routineId).toMatch(/^r-it-/);
});

test("the fired session binds as its routine's ATTESTED creator", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript({ parent: [{ say: "nothing to report" }] }));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say nothing",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const started = await waitFor(
    async () => (await readAuditRows({ actions: ["egress.policy"], sinceIso })).find((r) => r.surface === CHANNEL),
    "a session.started egress.policy row for the fire",
    150_000,
  );
  expect(started.principalId).toBe(CREATOR);
  expect(started.principalId).not.toBe("eve:app");
});

test("a routine fire's reply.post row keeps the schedule app as AUTHOR and adds the creator to DETAIL — terminal route", async () => {
  await bootAgent({ sharedSqlite: true });
  const sayText = "oe-660 terminal route fire reply";
  disposeLater(registerScript({ parent: [{ say: sayText }] }));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say something short",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const reply = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.find((r) => r.detail?.chars === sayText.length && r.surface === CHANNEL);
  }, "the routine fire's reply.post row (terminal route)", 150_000);

  expect(reply.detail?.route).toBe("terminal");
  expect(reply.principalId).toBe("eve:app");
  expect(reply.detail?.creatorId).toBe(CREATOR);
});

test("a routine fire's reply.post row keeps the schedule app as AUTHOR and adds the creator to DETAIL — bridge route", async () => {
  await bootAgent({ sharedSqlite: true });
  const sayText = "oe-660 bridge route fire reply, deliberately longer";
  disposeLater(registerScript({ parent: [{ say: sayText }] }));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await seedDueRoutine({
    surfaceKey: `slack/T0EXAMPLE/${BRIDGE_CHANNEL}`,
    channelId: BRIDGE_CHANNEL,
    prompt: "say something short",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const reply = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.find((r) => r.detail?.chars === sayText.length && isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL));
  }, "the routine fire's reply.post row (bridge route)", 150_000);

  expect(reply.detail?.route).toBe("bridge");
  expect(reply.principalId).toBe("eve:app");
  expect(reply.detail?.creatorId).toBe(CREATOR);
});

test("OPE-702 — a chars-only reply.post match is ambiguous across channels; surface scoping resolves it", async () => {
  await bootAgent({ sharedSqlite: true });
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const decoyCore = "oe-702 decoy (terminal route, fired first)";
  const realCore = "oe-702 real reply (bridge route, fired second)";
  const padLen = Math.max(decoyCore.length, realCore.length) + 3;
  const decoyText = decoyCore.padEnd(padLen, ".");
  const realText = realCore.padEnd(padLen, ".");
  expect(decoyText.length).toBe(realText.length);

  const decoyHandle = registerScript({ parent: [{ say: decoyText }] });
  await seedDueRoutine({ surfaceKey: `slack/${TEAM}/${CHANNEL}`, channelId: CHANNEL, prompt: "say something", createdBy: CREATOR });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);
  const decoyRow = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.find((r) => r.surface === CHANNEL && r.detail?.chars === decoyText.length);
  }, "the decoy terminal-route reply.post row", 150_000);
  expect(decoyRow.detail?.route).toBe("terminal");
  decoyHandle.dispose();

  disposeLater(registerScript({ parent: [{ say: realText }] }));
  await seedDueRoutine({
    surfaceKey: `slack/T0EXAMPLE/${BRIDGE_CHANNEL}`,
    channelId: BRIDGE_CHANNEL,
    prompt: "say something",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);
  const realRow = await waitFor(async () => {
    const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
    return rows.find((r) => isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL) && r.detail?.chars === realText.length);
  }, "the real bridge-route reply.post row", 150_000);
  expect(realRow.detail?.route).toBe("bridge");

  const allRows = await readAuditRows({ actions: ["reply.post"], sinceIso });
  const chansOnlyMatches = allRows.filter((r) => r.detail?.chars === realText.length);
  expect(chansOnlyMatches.length).toBeGreaterThanOrEqual(2);
  expect(chansOnlyMatches.some((r) => r.surface === CHANNEL && r.detail?.route === "terminal")).toBe(true);
  expect(chansOnlyMatches.some((r) => isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL) && r.detail?.route === "bridge")).toBe(true);

  const scoped = allRows.find((r) => isBridgeSurfaceFor(r.surface, BRIDGE_CHANNEL) && r.detail?.chars === realText.length);
  expect(scoped?.detail?.route).toBe("bridge");
});

test("NEGATIVE CONTROL — an ATTENDED wake proposing the same verb passes the fence and cards, unattended:false", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript(proposeSpendLimit()));
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  await discordMentionWake({ channelId: DISCORD_UNLISTED, text: `<@9000000000000000001> please raise the monthly cap` });

  const chain = await waitFor(
    async () => chainRowFor(await readAuditRows({ actions: ["approval.chain"], sinceIso }), "set_spend_limit"),
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
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const routineId = await seedDueRoutine({
    surfaceKey: `slack/${TEAM}/${CHANNEL}`,
    channelId: CHANNEL,
    prompt: "say something short",
    createdBy: CREATOR,
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const sent = await waitFor(
    async () =>
      (await readAuditRows({ actions: ["routine.fire_attrs_sent"], sinceIso })).find(
        (r) => (r.detail as { routineId?: string }).routineId === routineId,
      ),
    `a routine.fire_attrs_sent row for ${routineId}`,
    150_000,
  );
  const seen = await waitFor(
    async () => (await readAuditRows({ actions: ["routine.fire_attrs_seen"], sinceIso })).find((r) => r.surface === CHANNEL),
    "a routine.fire_attrs_seen row for the fired session",
    150_000,
  );

  for (const stamp of FIRE_STAMPS) expect(keysOf(sent)).toContain(stamp);

  const TURN_BOUNDARY_ATTRS = ["oe_dispatch_turn", "oe_parent_turn_tainted"];
  const seenFromHop = keysOf(seen).filter((k) => !TURN_BOUNDARY_ATTRS.includes(k));
  expect([...seenFromHop].sort()).toEqual([...keysOf(sent)].sort());

  for (const k of keysOf(sent)) expect(keysOf(seen)).toContain(k);

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
