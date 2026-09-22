import { afterAll, expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
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

function armDelegation(tag: string): ScriptedHandle {
  return disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: `read ${PAGE_URL} and quote it` }, id: `ope1947-${tag}-delegate` }] },
        { say: "NO_REPLY" },
      ],
      child: [{ say: "reported" }],
    }),
  );
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
  const own = request.messages.filter((m) => m.text.includes(taskId));
  expect(own.length, `no settlement notification naming ${taskId} in the turn the seat was woken with`).toBeGreaterThan(0);
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
    await waitFor(() => ownHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "own: the dispatch turn's own terminal step");
    const ownArmed = disposeLater(armSettlement(ownHandle, SETTLEMENT_DRAIN_SCRIPT));

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

    const ownTaskId = taskIdOfDelegation(ownHandle, "the own-account delegation");
    const settlement = await consumeSettlement({ armed: ownArmed, dispatched: ownHandle, taskId: ownTaskId, label: "own: the failed worker's settlement wake" });
    const settlementText = settlementNotificationText(settlement, ownTaskId);
    expect(settlementText, `🔴 own: the settlement report does not carry the refusal — the member still gets a dead delegation. Saw ${JSON.stringify(settlementText.slice(0, 600))}`).toContain(await routeIndependentRefusalOpening());
    expect(settlementText, "🔴 own: the settlement report carries the bare tripwire message instead of the refusal").not.toContain("identical-binding invariant VIOLATED");
    ownArmed.dispose();
    ownHandle.dispose();

    const cursorPlain = await auditCursor();
    const plainHandle = armDelegation("plain");
    await discordMentionWake({
      channelId: DISCORD_LISTED_CHANNEL_ID,
      text: `${BOT_MENTION} read this page and quote one sentence from it`,
      messageId: "ope1947-plain",
    });
    await waitFor(() => plainHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "plain: the dispatch turn's own terminal step");
    const plainArmed = disposeLater(armSettlement(plainHandle, SETTLEMENT_DRAIN_SCRIPT));

    await waitForChildren(plainHandle, { count: 1, lastStepIndex: 0, label: "plain: the worker's terminal step" });
    expect(plainHandle.requests.filter((r) => r.fault !== undefined), "plain: the scripted model reported a fault").toEqual([]);

    expect(notionActingRows(await rowsSinceCursor(cursorPlain, [ACTING_IDENTITY])).filter((r) => r.tool === "egress:notion-rest"), "🔴 plain: the ordinary read wrote a route refusal row — the gate refuses everything").toEqual([]);
    expect(await rowsSinceCursor(cursorPlain, [EGRESS_REFUSAL]), "🔴 plain: the ordinary read withheld a host").toEqual([]);
    expect(
      (await rowsSinceCursor(cursorPlain, [EGRESS_POLICY])).filter((r) => (r.detail ?? {})["reason"] === "subagent-binding-divergence"),
      "🔴 plain: the ordinary delegation's worker diverged from its seat too — arm 1's divergence is not about the ask",
    ).toEqual([]);

    await consumeSettlement({ armed: plainArmed, dispatched: plainHandle, taskId: taskIdOfDelegation(plainHandle, "the ordinary delegation"), label: "plain: the worker's settlement wake" });
    plainArmed.dispose();
  },
);
