import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bootAgent, disposeLater, registerScript, runRoutineDispatchTick, waitFor } from "../harness";
import {
  EVE_PATCH_PARTS,
  _resetEvePatchTurnCheckForTest,
  defaultEvePackageRoot,
  evePatchTurnCheckHasPassed,
} from "@open-everywhere/core/agent/access/eve-patch-probe.js";

const PATCH_MARKER = /^__oe[A-Za-z0-9_]*Patched$/;

async function seedDueRoutine(surfaceKey: string, channelId: string): Promise<string> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const { randomBytes } = await import("node:crypto");
  const id = `r-it-epg-${randomBytes(4).toString("hex")}`;
  const [platform = "slack", workspace = "", surface = ""] = surfaceKey.split("/");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform,
      workspace,
      surface,
      workspaceKey: `${platform}/${workspace}`,
      surfaceKey,
      domainKey: surfaceKey,
      key: surfaceKey,
    },
    {
      id,
      org: "default",
      surfaceKey,
      target: { channelId },
      trigger: { kind: "once", at: dueAt },
      prompt: "say nothing of consequence; this fire exists to drive one turn",
      createdBy: "U0EVEPATCHGATE",
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
    },
  );
  return id;
}

test("§1 the turn gate's hook RUNS when a real fire drives a turn", async () => {
  await bootAgent({ sharedSqlite: true });
  disposeLater(registerScript({ parent: [{ say: "eve patch gate probe turn" }] }));

  const routineId = await seedDueRoutine("slack/T0EVEPATCH/C0EVEPATCH", "C0EVEPATCH");
  expect(routineId).toMatch(/^r-it-epg-/);

  _resetEvePatchTurnCheckForTest();
  expect(evePatchTurnCheckHasPassed(), "the trace is clear before the fire — otherwise §1 proves nothing").toBe(false);

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length, "the dispatch tick started at least one session").toBeGreaterThan(0);

  await waitFor(
    async () => evePatchTurnCheckHasPassed() || undefined,
    "hooks/eve-patch-gate.ts's turn.started handler to run on the real host. Never true means the hook " +
      "is not mounted or not reached, so the unpatched-eve refusal is unreachable at the turn edge",
  );
  expect(evePatchTurnCheckHasPassed()).toBe(true);
});

test("§2 the gate passes on THIS host because eve 1.x declares no runtime marker part, and the eve this host resolves carries the one patch part", async () => {
  await bootAgent({ sharedSqlite: true });
  expect(EVE_PATCH_PARTS.map((p) => p.part), "eve 1.x declares no live runtime patch part (parts 1 and 4 retired with eve 0.x)").toEqual([]);
  expect(
    ["__oeProjectToolSetPatched", "__oeCompactionContractPatched"].every((m) => PATCH_MARKER.test(m)),
    "the marker pattern matches the retired part 1 and part 4 markers, so an empty match below is not a blind pattern",
  ).toBe(true);
  const published = Object.keys(globalThis).filter((k) => PATCH_MARKER.test(k)).sort();
  expect(
    published,
    "the booted host publishes exactly the markers EVE_PATCH_PARTS declares. A marker with no row is checked by nothing at the turn edge; it also means this process loaded stale patched eve bytes",
  ).toEqual(EVE_PATCH_PARTS.map((p) => p.marker).sort());
  const boundary = readFileSync(join(defaultEvePackageRoot(), "dist", "src", "internal", "authored-package-boundary.js"), "utf8");
  expect(
    boundary.includes("function __oeResolvesThroughInstalledPackage("),
    "the eve this host resolved carries patch part 10 (the authored-package boundary). It plants no runtime marker, so the turn gate cannot see it; test:eve-install pins it in the committed patch",
  ).toBe(true);
});
