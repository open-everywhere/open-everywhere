import { randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { bootAgent, discordMentionWake, readAuditRows, registerScript, waitFor, wrapToolExecute, type ScriptedHandle } from "./harness";

const perTest: (() => void)[] = [];
afterEach(() => {
  for (const c of perTest.splice(0)) c();
});

function disposeLater(handle: ScriptedHandle): ScriptedHandle {
  perTest.push(() => handle.dispose());
  return handle;
}

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

test("a turn that runs past its step budget trips the soft and then the hard boundary, with one audit row per crossing", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 2, stepBackstopMultiple: 2 } });
  expect(settings.getSettings().turn.stepBudget).toBe(2);
  expect(settings.getSettings().turn.stepBackstopMultiple).toBe(2);
  perTest.push(() => settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } }));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  perTest.push(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "list_routines", input: {}, id: "s1" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s2" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s3" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s4" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s5" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "s6" }] },
        { say: "should never be reached — the hard backstop ends the turn first" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> loop please" });

  const rows = await waitFor(async () => {
    const found = (await readAuditRows({ actions: ["turn.step_boundary"], sinceIso })).filter((r) => r.surface === channelId);
    return found.length > 0 ? found : undefined;
  }, "at least one turn.step_boundary audit row");

  const byTier = new Map(rows.map((r) => [(r.detail ?? {}).tier as string, r]));
  expect(byTier.has("soft")).toBe(true);
  const soft = byTier.get("soft")!;
  expect(soft.detail?.steps).toBe(3);
  expect(soft.detail?.budget).toBe(2);
  expect(soft.detail?.backstop).toBe(4);

  const hard = await waitFor(async () => {
    const found = (await readAuditRows({ actions: ["turn.step_boundary"], sinceIso })).filter((r) => r.surface === channelId);
    return found.find((r) => (r.detail ?? {}).tier === "hard");
  }, "a hard turn.step_boundary audit row");
  expect(hard.detail?.steps).toBe(5);
  expect(hard.detail?.budget).toBe(2);
  expect(hard.detail?.backstop).toBe(4);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests.some((r) => r.stepIndex >= 5)).toBe(false);
});

test("a turn that stays within budget never writes a turn.step_boundary row", async () => {
  await bootAgent();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 50, stepBackstopMultiple: 3 } });
  perTest.push(() => settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } }));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  perTest.push(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "list_routines", input: {}, id: "n1" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "n2" }] },
        { say: "done, well within budget" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> short please" });

  await waitFor(() => handle.requests.find((r) => r.stepIndex === 2), "the parent's terminal step to be served");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  await new Promise((r) => setTimeout(r, 500));
  const rows = await readAuditRows({ actions: ["turn.step_boundary"], sinceIso });
  expect(rows.filter((r) => r.surface === channelId)).toEqual([]);
});
