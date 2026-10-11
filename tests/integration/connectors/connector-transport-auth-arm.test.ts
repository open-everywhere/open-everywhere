import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  slackDmWake,
  slackMentionWake,
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackTs,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0IT1465OPERATOR";
const BOT_USER_ID = "U0IT1465BOT";

let tsCounter = 0;

const POSTED: { readonly channel: string; readonly text: string }[] = [];

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
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
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
      case "conversations.open":
        return { ok: true, channel: { id: DM_CHANNEL_ID } };
      case "chat.postMessage":
        POSTED.push({ channel: params.get("channel") ?? "", text: params.get("text") ?? "" });
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
  const search = { tool: "connection_search", input: { query: "handbook" }, id: `it1465-${input.label}-search` };
  const delegateId = `it1465-${input.label}-delegate`;
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "look in notion" }, id: delegateId }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: 120_000, calls: [search] }, { say: "reported" }],
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

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${input.label}: the seat's receipt step`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: `${input.label}: the worker to enter its hold` });
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, delegateId, `${input.label}: the forward`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `${input.label}: the worker's terminal step` });
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `${input.label}: the seat's result-wake step` });
  expect(resultStep.fault).toBeUndefined();
  for (const h of [handle, settlement]) expect(h.requests.filter((r) => r.fault !== undefined), `${input.label}: the scripted model reported a fault`).toEqual([]);
  settlement.dispose();
  handle.dispose();
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
      'needs-sign-in: connection "notion" needs the person who asked to connect their own account',
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
      "needs-sign-in",
    );

    expect(await notionMintRows(cursor), "the OFF arm minted a per-user token with connectors.userPrincipal off").toEqual([]);
  } finally {
    stub.uninstall();
  }
});

test("OPE-2462: a DM job's personal sign-in is said once by the host, and the sign-in resumes the job on its own", async () => {
  await bootAgent();
  const flows = await import("@open-everywhere/core/agent/connections/user-auth-flow.js");
  const consentResume = await import("@open-everywhere/core/agent/connections/consent-resume.js");
  const { rawIdLeaks } = await import("@open-everywhere/core/agent/channels/friendly-ids.js");
  const live = flows.userAuthFlowProvider();
  expect(live, "no user-auth flow is registered, so no personal mint can reach the sign-in").toBeDefined();
  const consents: unknown[] = [];
  flows.registerUserAuthFlow({
    ...live!,
    mintServiceToken: (r, o) => live!.mintServiceToken(r, o),
    mintUserToken: (r, p) => live!.mintUserToken(r, p),
    isUserAuthRequired: (e) => live!.isUserAuthRequired(e),
    environmentClaim: () => live!.environmentClaim(),
    startAuthorization: async (_ref, _params, options) => {
      consents.push(options.consent);
      return { url: "https://connect.example.invalid/auth/IT2462" };
    },
  });
  const stub = armSlackStub();
  try {
    await armUserPrincipal(true);
    const postedBefore = POSTED.length;
    const cursor = await auditCursor();
    const search = { tool: "connection_search", input: { query: "handbook" }, id: "it2462-search" };
    const handle = disposeLater(
      registerScript({
        parent: [{ calls: [{ tool: "work", input: { message: "look in notion" }, id: "it2462-delegate" }] }, { say: NO_REPLY_SENTINEL }],
        child: [{ delayMs: 120_000, calls: [search] }, { say: "Notion needs your sign-in." }],
      }),
    );
    const ts = slackTs(Date.now(), (tsCounter += 1));
    const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OPERATOR_ID, text: "it2462 connect notion", ts, eventId: `EvIT2462${ts.replace(".", "")}` });
    expect(res.status, `the Slack front refused the DM wake: ${res.body.slice(0, 200)}`).toBe(200);
    await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2462: the seat's receipt step");
    await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "it2462: the worker to enter its hold" });
    const seat = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
    const taskId = await workTaskIdOfCall(cursor, handle, "it2462-delegate", "it2462: the forward");
    handle.releaseHolds();
    await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "it2462: the worker's terminal step" });

    const output = connectionSearchOutputs(handle).join("\n");
    expect(output, "the worker did not settle needs-sign-in with a delivered card").toContain("A sign-in card with a private link went to that person directly.");
    expect(output, "the worker's report promises no automatic resume").toContain("When they connect, the host starts this job again.");

    const card = POSTED.slice(postedBefore).find((p) => p.text.includes("connect.example.invalid/auth/IT2462"));
    expect(card, `no sign-in card was posted. Saw ${JSON.stringify(POSTED.slice(postedBefore))}`).toBeDefined();
    expect(card!.text, "the card does not say the job resumes on its own").toContain("Once you connect it, I pick the job up again.");
    expect(card!.text, "🔴 the card in the person's own DM still carries the who-asked footer").not.toContain("asked for this");
    expect(rawIdLeaks(card!.text), "🔴 the card shows a raw id or a scope key").toEqual([]);

    const result = await awaitWorkResult({ handle: seat, taskId, label: "it2462: the seat's result-wake step" });
    const resultText = result.messages.map((m) => m.text).join("\n");
    const note = [...resultText.matchAll(/<system-note>([\s\S]*?)<\/system-note>/g)].map((m) => m[1]!).filter((n) => n.includes(`task ${taskId}`)).at(-1) ?? "";
    expect(note, "🔴 the result wake does not tell the seat the host already sent the link").toContain("ALREADY sent them a private sign-in link in this conversation");
    expect(note, "the result wake still tells the seat to relay the stop").not.toContain("relay what came back");
    const wakes = (await rowsSinceCursor(cursor, ["work.result_wake"])).filter((r) => r.detail?.taskId === taskId);
    expect(wakes.map((r) => [r.detail?.outcome, r.detail?.signIn]), "W's result-wake row does not record the quiet sign-in").toEqual([["delivered", "quiet"]]);
    expect(seat.requests.filter((r) => r.fault !== undefined), "it2462: the result-wake script reported a fault").toEqual([]);
    seat.dispose();
    const resumeCallId = "it2462-resume";
    const seat2 = disposeLater(
      armSettlement(handle, {
        parent: [
          { calls: [{ tool: "work", input: { message: "The account is connected. Finish what was asked.", taskId }, id: resumeCallId }] },
          { say: NO_REPLY_SENTINEL },
          { say: "The handbook is the onboarding page in Notion." },
          { say: "The handbook is the onboarding page in Notion." },
          { say: "The handbook is the onboarding page in Notion." },
        ],
      }),
    );
    expect(handle.requests.filter((r) => r.fault !== undefined), "it2462: the worker's first turn reported a fault").toEqual([]);
    handle.dispose();
    const continued = disposeLater(registerScript({ parent: [], child: [{ say: "The handbook is in Notion: the onboarding page." }] }));

    const record = consentResume.asConsentResumeRecord(JSON.parse(JSON.stringify(consents.at(-1))));
    expect(record, "the link mint carried no consent record").toBeDefined();
    const lines: string[] = [];
    const outcome = await consentResume.resumeAfterConsent(record!, {
      post: async (_t, text) => (lines.push(text), "1.0"),
    });
    expect(outcome.verdict, "the return hop did not resume the job").toBe("resumed");
    expect(lines, "the connect line does not say the pick-up").toEqual(["Your Notion account is connected. I'm picking up your request now."]);
    const resumed = await waitFor(
      () => seat2.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes("sign-in-resume-"))),
      "it2462: the seat's resume-wake step",
    );
    const resumeText = resumed.messages.map((m) => m.text).join("\n");
    expect(resumeText, "the resume wake does not tell the seat to run the same job").toContain(`taskId: &quot;${taskId}&quot;`);
    expect(resumeText, "the resume wake does not keep the seat from listing tools").toContain("Do not list tools");

    const admitted = await waitForAuditRows({
      probe: async () => {
        const rows = (await rowsSinceCursor(cursor, ["delegation.continuation_admitted"])).filter((r) => r.detail?.task === taskId);
        return rows.length > 0 ? rows : undefined;
      },
      label: "it2462: the resume's continuation admission",
      actions: ["delegation.continuation_admitted"],
      cursor,
    });
    expect(admitted.length, "the resume wake's `work` call was not admitted as a continuation").toBeGreaterThan(0);
    const finalWake = await waitForAuditRows({
      probe: async () => {
        const rows = (await rowsSinceCursor(cursor, ["work.result_wake"])).filter((r) => r.detail?.taskId === taskId && r.detail?.signIn === undefined);
        return rows.length > 0 ? rows : undefined;
      },
      label: "it2462: the continued job's result wake",
      actions: ["work.result_wake"],
      cursor,
    });
    expect(finalWake.map((r) => [r.detail?.outcome, r.detail?.reportOwed]), "🔴 the continued job's result wake does not owe the room its answer").toEqual([["delivered", true]]);
    expect(continued.requests.filter((r) => r.fault !== undefined), "it2462: the continued worker turn reported a fault").toEqual([]);
    expect(continued.requests.some((r) => r.role === "child"), "it2462: the continued task never reached a worker turn").toBe(true);
  } finally {
    flows.registerUserAuthFlow(live!);
    stub.uninstall();
  }
});
