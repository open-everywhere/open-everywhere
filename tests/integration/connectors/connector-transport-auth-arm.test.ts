import { expect, test } from "vitest";
import {
  auditCursor,
  awaitTaskSettlement,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_SCRIPT,
  slackDmWake,
  slackMentionWake,
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackTs,
  taskIdOfDelegation,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0IT1465OPERATOR";
const BOT_USER_ID = "U0IT1465BOT";

let tsCounter = 0;

function armSlackStub(): { uninstall(): void } {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0IT1465BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: {
            id,
            name: "it1465-operator",
            team_id: SLACK_TEAM_ID,
            is_bot: false,
            is_restricted: false,
            is_ultra_restricted: false,
            is_stranger: false,
            profile: { display_name: "it1465-operator", real_name: "IT 1465 Operator" },
          },
        };
      }
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it1465-control",
            is_channel: true,
            is_private: false,
            is_ext_shared: false,
            is_org_shared: false,
            is_shared: false,
            is_pending_ext_shared: false,
            num_members: 6,
          },
        };
      case "conversations.history":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      default:
        return undefined;
    }
  });
}

async function armUserPrincipal(on: boolean): Promise<void> {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ connectors: { userPrincipal: on } });
  expect(settings.getSettings().connectors.userPrincipal, `the ${on ? "ON" : "OFF"} arm did not take the flag it drives`).toBe(on);
}

function connectionSearchOutputs(handle: ScriptedHandle): readonly string[] {
  const out: string[] = [];
  for (const r of handle.requests) for (const t of r.toolResults) if (t.name === "connection_search") out.push(String(t.output));
  return out;
}

async function notionMintRows(cursor: AuditCursor): Promise<readonly AuditRow[]> {
  const rows = await rowsSinceCursor(cursor, ["connector.mint"]);
  return rows.filter((r) => r.detail?.connector === "notion");
}

async function driveConnectorTurn(input: {
  readonly label: string;
  readonly origin: "dm" | "channel";
}): Promise<ScriptedHandle> {
  const search = { tool: "connection_search", input: { keywords: "handbook" }, id: `it1465-${input.label}-search` };
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look in notion" }, id: `it1465-${input.label}-delegate` }] }, { say: "handed off" }],
      child: [{ calls: [search] }, { say: "reported" }],
    }),
  );

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res =
    input.origin === "dm"
      ? await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OPERATOR_ID, text: `it1465 ${input.label}`, ts, eventId: `EvIT1465${input.label}${ts.replace(".", "")}` })
      : await slackMentionWake({
          channelId: SLACK_NAME_DROP_CHANNEL_ID,
          userId: OPERATOR_ID,
          text: `<@${BOT_USER_ID}> it1465 ${input.label}`,
          ts,
          eventId: `EvIT1465${input.label}${ts.replace(".", "")}`,
        });
  expect(res.status, `the Slack front refused the ${input.origin} wake: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${input.label}: the seat's terminal step`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `${input.label}: the worker's terminal step` });
  expect(handle.requests.filter((r) => r.fault !== undefined), `${input.label}: the scripted model reported a fault`).toEqual([]);

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, `the it1465 ${input.label} delegation`),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: `${input.label}: the worker's settlement wake`,
  });
  disposeLater(drained.handle);
  drained.handle.dispose();
  return handle;
}

test("a slackDmWake turn reaches the connector plane as mode \"dm\"; the same drive from a CHANNEL is refused as ungranted", async () => {
  await bootAgent();

  const { loadBundles, loadBindings } = await import("../../../agent/access/bundles");
  const bundle = loadBundles().find((b) => b.name === "notion-personal");
  expect(bundle, "the `notion-personal` bundle is gone from agent/access/bundles.ts — no arm here can bind a user-oauth credential").toBeDefined();
  const notionGrant = (bundle?.connectors ?? []).find((c) => (typeof c === "string" ? c : c.name) === "notion");
  expect(
    typeof notionGrant === "string" ? undefined : notionGrant?.credential,
    "`notion-personal` no longer grants notion at the `user-oauth` credential",
  ).toBe("user-oauth");
  expect(
    loadBindings().some(
      (b) => b.bundle === "notion-personal" && b.scope.level === "principal" && b.scope.principal === `slack/${SLACK_TEAM_ID}/${OPERATOR_ID}`,
    ),
    `no principal binding of \`notion-personal\` to slack/${SLACK_TEAM_ID}/${OPERATOR_ID} — the drives below would resolve no connector at all`,
  ).toBe(true);

  const stub = armSlackStub();
  try {
    await armUserPrincipal(true);

    const dmCursor = await auditCursor();
    await driveConnectorTurn({ label: "dm-ingress", origin: "dm" });
    const dmUse = await waitForAuditRows({
      probe: async () => {
        const rows = await rowsSinceCursor(dmCursor, ["connector.use"]);
        return rows.find((r) => r.detail?.connection === "notion");
      },
      label: "the DM turn's own connector.use row",
      actions: ["connector.use"],
      cursor: dmCursor,
    });
    expect(dmUse.detail?.mode, "the DM wake did not reach the connector plane as a DM — the helper produced a channel binding").toBe("dm");

    const channelCursor = await auditCursor();
    const channelHandle = await driveConnectorTurn({ label: "channel-control", origin: "channel" });
    const refused = await waitForAuditRows({
      probe: async () => {
        const rows = await rowsSinceCursor(channelCursor, ["connector.refused"]);
        return rows.find((r) => r.detail?.connection === "notion");
      },
      label: "the channel turn's own connector.refused row",
      actions: ["connector.refused"],
      cursor: channelCursor,
    });
    expect(refused.detail?.reason, "the channel control was refused for some other reason than the missing grant").toBe("ungranted");
    expect(
      (await rowsSinceCursor(channelCursor, ["connector.use"])).filter((r) => r.detail?.connection === "notion"),
      "a CHANNEL-origin turn reached the notion connector's credential gate — the DM universe is not confining the principal binding",
    ).toEqual([]);
    expect(
      connectionSearchOutputs(channelHandle).join("\n"),
      "the channel control produced no connection_search output to read at all",
    ).toContain("not granted to this surface");
  } finally {
    stub.uninstall();
  }
});

test("connectors.userPrincipal ON selects userAwareProviderToken: the DM turn takes the per-user MINT path and stamps subject \"user\"", async () => {
  await bootAgent();

  const stub = armSlackStub();
  try {
    await armUserPrincipal(true);
    const cursor = await auditCursor();
    const handle = await driveConnectorTurn({ label: "arm-on", origin: "dm" });

    const output = connectionSearchOutputs(handle).join("\n");
    expect(output, "the ON arm produced no connection_search output at all").not.toBe("");
    expect(output, "the ON arm did not reach the per-user mint — the transport selected the APP builder").toContain(
      "no user-auth-flow provider is registered",
    );
    expect(output, "the ON arm took the app-principal refusal, so the ternary selected the wrong builder").not.toContain(
      "is not valid on an app connection",
    );

    const mints = await waitForAuditRows({
      probe: async () => {
        const rows = await notionMintRows(cursor);
        return rows.length > 0 ? rows : undefined;
      },
      label: "the ON arm's connector.mint row",
      actions: ["connector.mint"],
      cursor,
    });
    expect(mints.map((r) => r.detail?.subject), "the ON arm minted for something other than the user").toEqual(mints.map(() => "user"));
  } finally {
    stub.uninstall();
  }
});

test("connectors.userPrincipal OFF selects appProviderToken: the SAME DM turn refuses the user-oauth credential and writes NO mint row", async () => {
  await bootAgent();

  const stub = armSlackStub();
  try {
    await armUserPrincipal(false);
    const cursor = await auditCursor();
    const handle = await driveConnectorTurn({ label: "arm-off", origin: "dm" });

    const output = connectionSearchOutputs(handle).join("\n");
    expect(output, "the OFF arm produced no connection_search output at all").not.toBe("");
    expect(output, "the OFF arm did not take the app-principal path — the transport selected the USER-AWARE builder").toContain(
      "is not valid on an app connection",
    );
    expect(output, "the OFF arm reached the per-user mint, so the ternary selected the wrong builder").not.toContain(
      "no user-auth-flow provider is registered",
    );

    expect(await notionMintRows(cursor), "the OFF arm minted a per-user token with connectors.userPrincipal off").toEqual([]);
  } finally {
    stub.uninstall();
  }
});
