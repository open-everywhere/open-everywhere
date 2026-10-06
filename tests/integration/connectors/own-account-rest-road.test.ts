import { afterAll, expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  awaitWindowQuiet,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const BOT_MENTION = "<@9000000000000000001>";
const PAGE_URL = "https://api.notion.com/v1/pages/6f7ea678-1947-4000-8000-000000000001";

const ACTING_IDENTITY = "connector.acting_identity";
const EGRESS_REFUSAL = "egress.own_account_refusal";
const EGRESS_POLICY = "egress.policy";
const WORK_RESULT_WAKE = "work.result_wake";

afterAll(async () => {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

async function pinVendorHostIsCredentialed(): Promise<void> {
  const { loadBundles } = await import("../../../agent/access/bundles");
  const bundle = loadBundles().find((b) => b.name === "notion-connectors");
  expect(bundle, `the "notion-connectors" bundle is gone — this file cannot measure a withholding`).toBeDefined();
  const connection = (bundle?.connections ?? []).find((c) => c.id === "notion-rest");
  expect(connection?.allowedWebsites, `the "notion-rest" connection no longer reaches api.notion.com`).toContain("api.notion.com");
  expect(connection?.secretRef, `the "notion-rest" connection carries no credential — nothing would be stamped`).toBeTruthy();
}

const delegateId = (tag: string): string => `ope1947-${tag}-delegate`;

function armDelegation(tag: string): ScriptedHandle {
  return disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: `read ${PAGE_URL} and quote it` }, id: delegateId(tag) }] },
        { delayMs: 120_000, say: "NO_REPLY" },
      ],
      child: [{ say: "reported" }],
    }),
  );
}

async function settleArm(handle: ScriptedHandle, tag: string): Promise<ScriptedHandle> {
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${tag}: the seat's held receipt step`);
  const armed = disposeLater(armSettlement(handle, { parent: [{ say: "NO_REPLY" }] }));
  handle.releaseHolds();
  return armed;
}

async function taskIdOfArm(cursor: AuditCursor, handle: ScriptedHandle, tag: string): Promise<string> {
  return await workTaskIdOfCall(cursor, handle, delegateId(tag), tag);
}

function unescapeXml(s: string): string {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function hostNotes(text: string): string {
  return [...text.matchAll(/<system-note>([\s\S]*?)<\/system-note>/g)].map((m) => unescapeXml(m[1] ?? "")).join("\n");
}

function notionActingRows(rows: readonly AuditRow[]): { refused: unknown; tool: unknown; askRecognised: unknown; requiredIdentity: unknown; identity: unknown }[] {
  return rows
    .filter((r) => r.action === ACTING_IDENTITY && (r.detail ?? {})["connector"] === "notion")
    .map((r) => {
      const d = r.detail ?? {};
      return { askRecognised: d["askRecognised"], identity: d["identity"], refused: d["refused"], requiredIdentity: d["requiredIdentity"], tool: d["tool"] };
    });
}

async function routeIndependentRefusalOpening(): Promise<string> {
  const { ownAccountRefusal } = await import("@open-everywhere/core/agent/connections/own-account-ask.js");
  const withRoute = ownAccountRefusal("notion", true, true);
  const withoutRoute = ownAccountRefusal("notion", false, false);
  let i = 0;
  while (i < withRoute.length && i < withoutRoute.length && withRoute[i] === withoutRoute[i]) i++;
  const opening = withRoute.slice(0, i).trimEnd();
  expect(opening.length, `the two route variants no longer share an opening, so this helper cannot derive the sentence. Saw ${JSON.stringify(opening)}`).toBeGreaterThan(80);
  return opening;
}

function settlementNotificationText(request: RecordedRequest, taskId: string): string {
  const own = request.messages.filter((m) => m.text.includes(`work-result-${taskId}`));
  expect(own.length, `no result wake for ${taskId} in the turn the seat was woken with`).toBeGreaterThan(0);
  return own.map((m) => m.text).join("\n");
}

async function waitForRows(cursor: AuditCursor, action: string, label: string): Promise<AuditRow[]> {
  return await waitFor(
    async () => {
      const rows = await rowsSinceCursor(cursor, [action]);
      return rows.length > 0 ? rows : undefined;
    },
    label,
    150_000,
  );
}

test(
  "an own-account ask withholds the vendor road from the delegated worker and writes the acting-identity row",
  { timeout: 420_000 },
  async () => {
    await bootAgent();
    await pinVendorHostIsCredentialed();

    const cursorOwn = await auditCursor();
    const ownHandle = armDelegation("own");
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `${BOT_MENTION} read this page using my own Notion account, and quote one sentence from it`,
      messageId: "ope1947-own",
    });
    const ownSettle = await settleArm(ownHandle, "own");
    const ownTaskId = await taskIdOfArm(cursorOwn, ownHandle, "own");

    const ownRows = notionActingRows(await waitForRows(cursorOwn, ACTING_IDENTITY, `own: a ${ACTING_IDENTITY} row for the withheld REST road`));
    expect(ownRows.length, `own: the window held ${ACTING_IDENTITY} rows, but none for notion`).toBeGreaterThan(0);
    expect(ownRows.every((r) => r.refused === true), `🔴 own: an acting-identity row that is NOT a refusal — the team key would have answered the ask. Saw ${JSON.stringify(ownRows)}`).toBe(true);
    expect(ownRows.every((r) => r.askRecognised === true), "own: the row does not record that an ask was recognised").toBe(true);
    expect(ownRows.every((r) => r.requiredIdentity === "human-acting"), "own: the row does not name the identity the request required").toBe(true);
    expect(ownRows.every((r) => r.identity === undefined), "🔴 own: a refused row still names an identity to run under").toBe(true);
    expect(ownRows.every((r) => r.tool === "egress:notion-rest"), `own: the row does not name the ROUTE it stopped. Saw ${JSON.stringify(ownRows.map((r) => r.tool))}`).toBe(true);

    expect((await rowsSinceCursor(cursorOwn, [EGRESS_REFUSAL])).length, "own: the egress plane wrote no refusal row").toBeGreaterThan(0);

    const divergence = (await rowsSinceCursor(cursorOwn, [EGRESS_POLICY])).filter((r) => (r.detail ?? {})["reason"] === "subagent-binding-divergence");
    expect(divergence.length, "🔴 own: no divergence row — the worker's policy no longer differs from its seat's. The road may have re-opened; do not pass this arm without re-establishing that the team key still answers nothing.").toBeGreaterThan(0);
    expect(divergence.every((r) => (r.detail ?? {})["aborted"] === true), "own: the tripwire fired without failing the child").toBe(true);
    expect(divergence.every((r) => (r.detail ?? {})["ownAccountWithheld"] === true), `🔴 own: the divergence row does not name the own-account withholding. Saw ${JSON.stringify(divergence.map((r) => r.detail))}`).toBe(true);
    expect(divergence.every((r) => (r.detail ?? {})["ownAccountConnector"] === "notion"), "own: the divergence row does not name the vendor whose road was withheld").toBe(true);

    expect(ownHandle.requests.filter((r) => r.role === "child"), "own: the failed worker still reached a model call — this arm's rows are no longer the whole story").toEqual([]);

    const settlement = await awaitWorkResult({ handle: ownSettle, taskId: ownTaskId, label: "own: the seat's result-wake step for the stopped worker" });
    const settlementText = settlementNotificationText(settlement, ownTaskId);
    const opening = await routeIndependentRefusalOpening();
    expect(hostNotes(settlementText), `🔴 own: the result wake's host note does not carry the refusal — the member still gets a dead delegation. Saw ${JSON.stringify(settlementText.slice(0, 900))}`).toContain(opening);
    expect(settlementText, "🔴 own: the settlement report carries the bare tripwire message instead of the refusal").not.toContain("identical-binding invariant VIOLATED");
    const ownWakes = (await rowsSinceCursor(cursorOwn, [WORK_RESULT_WAKE])).filter((r) => (r.detail ?? {})["taskId"] === ownTaskId);
    expect(ownWakes.map((r) => [(r.detail ?? {})["outcome"], (r.detail ?? {})["stoppedBy"], (r.detail ?? {})["connector"]]), "own: W's result-wake row does not name the egress stop").toEqual([["delivered", "egress-own-account", "notion"]]);
    expect(ownHandle.requests.filter((r) => r.fault !== undefined), "own: the scripted model reported a fault").toEqual([]);
    expect(ownSettle.requests.filter((r) => r.fault !== undefined), "own: the result-wake script reported a fault").toEqual([]);
    ownSettle.dispose();
    ownHandle.dispose();

    await awaitWindowQuiet();
    const cursorPlain = await auditCursor();
    const plainHandle = armDelegation("plain");
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `${BOT_MENTION} read this page and quote one sentence from it`,
      messageId: "ope1947-plain",
    });
    const plainSettle = await settleArm(plainHandle, "plain");
    const plainTaskId = await taskIdOfArm(cursorPlain, plainHandle, "plain");

    await waitForChildren(plainHandle, { count: 1, lastStepIndex: 0, label: "plain: the worker's terminal step" });
    expect(plainHandle.requests.filter((r) => r.fault !== undefined), "plain: the scripted model reported a fault").toEqual([]);

    expect(notionActingRows(await rowsSinceCursor(cursorPlain, [ACTING_IDENTITY])).filter((r) => r.tool === "egress:notion-rest"), "🔴 plain: the ordinary read wrote a route refusal row — the gate refuses everything").toEqual([]);
    expect(await rowsSinceCursor(cursorPlain, [EGRESS_REFUSAL]), "🔴 plain: the ordinary read withheld a host").toEqual([]);
    expect(
      (await rowsSinceCursor(cursorPlain, [EGRESS_POLICY])).filter((r) => (r.detail ?? {})["reason"] === "subagent-binding-divergence"),
      "🔴 plain: the ordinary delegation's worker diverged from its seat too — arm 1's divergence is not about the ask",
    ).toEqual([]);

    const plainSettlement = await awaitWorkResult({ handle: plainSettle, taskId: plainTaskId, label: "plain: the seat's result-wake step for the worker" });
    expect(hostNotes(settlementNotificationText(plainSettlement, plainTaskId)), "🔴 plain: the ordinary job's result wake says it was stopped").not.toContain("was STOPPED by the host");
    const plainWakes = (await rowsSinceCursor(cursorPlain, [WORK_RESULT_WAKE])).filter((r) => (r.detail ?? {})["taskId"] === plainTaskId);
    expect(plainWakes.map((r) => [(r.detail ?? {})["outcome"], (r.detail ?? {})["stoppedBy"]]), "🔴 plain: W's result-wake row names a stop for a job the host did not stop").toEqual([["delivered", undefined]]);
    expect(plainHandle.requests.filter((r) => r.fault !== undefined), "plain: the scripted model reported a fault after the result step").toEqual([]);
    expect(plainSettle.requests.filter((r) => r.fault !== undefined), "plain: the result-wake script reported a fault").toEqual([]);
  },
);
