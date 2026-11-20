import { afterAll, expect, test } from "vitest";
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
import { installHostFetchStub } from "../fetch-stub";
import { CONNECTOR_GATE_PROBE, installConnectorGateProbe, type ConnectorGateProbe } from "./connector-gate-probe";

const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0IT1465OPERATOR";
const BOT_USER_ID = "U0IT1465BOT";

let tsCounter = 0;

const SIGN_IN_TOOL = "notion__sign_in";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

/**
 * Notion's MCP endpoint, answering every call with HTTP 401: no arm here holds a token. On eve 1.x
 * the notion connector mount lists the ops anonymously when the person has not signed in, and a 401
 * makes it offer one tool, `notion__sign_in`. That tool's call runs the connection's OE resolver
 * with no listing marker: the same grant check, mint and sign-in card a connector op runs.
 */
function armNotionUnauthorized(): { readonly calls: readonly { url: string }[]; uninstall(): void } {
  return installHostFetchStub("https://mcp.notion.com/mcp", () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }));
}

let probe: ConnectorGateProbe | undefined;
/** Arm the Notion MCP stub, and the gate probe that captures the agent's own `notion__sign_in` where the mount offers it. */
function armGateProbe(): ConnectorGateProbe {
  if (probe !== undefined) return probe;
  probe = installConnectorGateProbe("notion", "sign_in");
  const armed = probe;
  cleanups.push(() => armed.restore());
  const vendor = armNotionUnauthorized();
  cleanups.push(() => vendor.uninstall());
  return armed;
}

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

function textOf(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function resultsOf(handle: ScriptedHandle, callId: string): readonly { readonly output: unknown; readonly isError: boolean }[] {
  const out: { output: unknown; isError: boolean }[] = [];
  for (const r of handle.requests) for (const t of r.toolResults) if (t.id === callId) out.push({ output: t.output, isError: t.isError });
  return out;
}

/**
 * What the connector mount offered the worker, as the worker's `eve__search` shows it. eve offers
 * `eve__search` only while the catalogue holds a deferred tool. So either the search ran and its
 * output is returned, or the worker's step held no `eve__search` at all: the catalogue was empty, and
 * the result is "". An absence check on the result therefore never reads a search that silently
 * failed for another reason.
 */
function catalogOutput(handle: ScriptedHandle, label: string): string {
  const callId = `it1465-${label}-search`;
  const step = handle.requests.find((r) => r.role === "child" && r.stepIndex === 0);
  expect(step, `control: ${label}: the worker never made its search step`).toBeDefined();
  const out = resultsOf(handle, callId);
  expect(out.length, `control: ${label}: the worker's eve__search returned nothing`).toBeGreaterThan(0);
  if (!step!.tools.includes("eve__search")) {
    expect(textOf(out[0]!.output), `control: ${label}: the search failed for a reason other than an empty catalogue`).toContain("eve__search");
    return "";
  }
  expect(out[0]!.isError, `control: ${label}: the worker's eve__search failed: ${textOf(out[0]!.output).slice(0, 400)}`).toBe(false);
  return textOf(out[0]!.output);
}

/** The output of the worker's connector call (the sign-in tool, or the gate probe). */
function connectorCallOutput(handle: ScriptedHandle, label: string): string {
  return resultsOf(handle, `it1465-${label}-call`).map((r) => textOf(r.output)).join("\n");
}

/** The call-time gate's refusal: the agent's own `notion__sign_in`, called through the probe, throws it. */
function probeRefusal(handle: ScriptedHandle, label: string): string {
  const out = resultsOf(handle, `it1465-${label}-call`);
  expect(out.length, `${label}: the gate probe returned nothing`).toBeGreaterThan(0);
  expect(out[0]!.isError, `🔴 ${label}: the call-time gate let the sign-in run: ${textOf(out[0]!.output).slice(0, 400)}`).toBe(true);
  return textOf(out[0]!.output);
}

async function notionMintRows(cursor: AuditCursor): Promise<readonly AuditRow[]> {
  const rows = await rowsSinceCursor(cursor, ["connector.mint"]);
  return rows.filter((r) => r.detail?.connector === "notion");
}

/**
 * One delegated turn: the worker searches the catalogue for the notion connection's tools, then
 * makes one call. `call: "sign-in"` calls `notion__sign_in` through `eve__tool`, where the mount
 * offers it. `call: "probe"` runs the connector gate probe, for an arm whose listing the gate
 * refuses, so the mount offers the model nothing to call. `call: "search"` makes a second
 * `eve__search`. `query` replaces the first search's query, and `secondQuery` the second's.
 */
async function driveConnectorTurn(input: {
  readonly label: string;
  readonly origin: "dm" | "channel";
  readonly call: "sign-in" | "probe" | "search";
  readonly query?: string;
  readonly secondQuery?: string;
}): Promise<ScriptedHandle> {
  const armed = armGateProbe();
  if (input.call === "probe") {
    expect(armed.captured(), `${input.label}: the gate probe holds no notion__sign_in yet — no earlier DM step offered it`).toBe(true);
  }
  const search = { tool: "eve__search", input: { query: input.query ?? "notion__" }, id: `it1465-${input.label}-search` };
  const callId = `it1465-${input.label}-call`;
  const call =
    input.call === "sign-in"
      ? { tool: "eve__tool", input: { name: SIGN_IN_TOOL, input: {} }, id: callId }
      : input.call === "search"
        ? { tool: "eve__search", input: { query: input.secondQuery ?? "notion pages" }, id: callId }
        : { tool: CONNECTOR_GATE_PROBE, input: {}, id: callId };
  const delegateId = `it1465-${input.label}-delegate`;
  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "look in notion" }, id: delegateId }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: 120_000, calls: [search] }, { calls: [call] }, { say: "reported" }],
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
  await waitForChildren(handle, { count: 1, lastStepIndex: 2, label: `${input.label}: the worker's terminal step` });
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
    const dmHandle = await driveConnectorTurn({ label: "dm-ingress", origin: "dm", call: "sign-in" });
    expect(catalogOutput(dmHandle, "dm-ingress"), "control: the DM's catalogue does not offer the notion sign-in").toContain(SIGN_IN_TOOL);
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
    const channelHandle = await driveConnectorTurn({ label: "channel-control", origin: "channel", call: "probe" });
    // On eve 1.x the grant check refuses the mount's LISTING in the channel, so the catalogue holds
    // no notion tool at all. The probe then runs the call-time gate on the channel's own session.
    expect(catalogOutput(channelHandle, "channel-control"), "🔴 the channel's catalogue offers a notion tool").not.toContain("notion__");
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
    expect(probeRefusal(channelHandle, "channel-control"), "the channel's call-time gate did not refuse the missing grant").toContain(
      "not granted to this surface",
    );
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
    const handle = await driveConnectorTurn({ label: "arm-on", origin: "dm", call: "sign-in" });

    expect(catalogOutput(handle, "arm-on"), "the ON arm's catalogue does not offer the notion sign-in").toContain(SIGN_IN_TOOL);
    const output = connectorCallOutput(handle, "arm-on");
    expect(output, "the ON arm produced no sign-in output at all").not.toBe("");
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
    // The probe needs the agent's notion__sign_in, which only an ON-arm DM step offers.
    if (!armGateProbe().captured()) {
      await armUserPrincipal(true);
      await driveConnectorTurn({ label: "arm-off-capture", origin: "dm", call: "sign-in" });
    }
    await armUserPrincipal(false);
    const cursor = await auditCursor();
    const handle = await driveConnectorTurn({ label: "arm-off", origin: "dm", call: "probe" });

    // The app builder refuses the user-oauth credential at the listing too, so the OFF arm's
    // catalogue holds no notion tool. The probe reads the call-time verdict on the same session.
    expect(catalogOutput(handle, "arm-off"), "🔴 the OFF arm's catalogue offers a notion tool").not.toContain("notion__");
    const output = probeRefusal(handle, "arm-off");
    expect(output, "the OFF arm's call-time gate did not refuse at all").not.toBe("");
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
    armGateProbe();
    const search = { tool: "eve__search", input: { query: "notion__" }, id: "it2462-search" };
    const signIn = { tool: "eve__tool", input: { name: SIGN_IN_TOOL, input: {} }, id: "it2462-sign-in" };
    const handle = disposeLater(
      registerScript({
        parent: [{ calls: [{ tool: "work", input: { message: "look in notion" }, id: "it2462-delegate" }] }, { say: NO_REPLY_SENTINEL }],
        child: [{ delayMs: 120_000, calls: [search] }, { calls: [signIn] }, { say: "Notion needs your sign-in." }],
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
    await waitForChildren(handle, { count: 1, lastStepIndex: 2, label: "it2462: the worker's terminal step" });

    const output = resultsOf(handle, "it2462-sign-in").map((r) => textOf(r.output)).join("\n");
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

/**
 * The ungranted-connector evidence on eve 1.x. The operator's DM holds notion (its catalogue offers
 * `notion__sign_in`, so the step holds `eve__search`) and does not hold the mounted `slack-as-you`
 * connection, whose listing the gate refuses. The worker searches for `slack-as-you` twice.
 */
test("a search for a mounted connection the surface does not hold writes the ungranted evidence row, and the permission proposal offers the grant", async () => {
  await bootAgent();

  const stub = armSlackStub();
  try {
    await armUserPrincipal(true);
    const cursor = await auditCursor();
    const handle = await driveConnectorTurn({ label: "dm-attempt", origin: "dm", call: "search", query: "slack-as-you search", secondQuery: "slack-as-you messages" });
    // The withholding stands: the gate refuses the listing, so the search finds no slack-as-you op.
    expect(catalogOutput(handle, "dm-attempt"), "control: the DM's catalogue holds no eve__search, so no search ran").not.toBe("");
    expect(catalogOutput(handle, "dm-attempt"), "🔴 the DM's catalogue offers a slack-as-you op").not.toContain("slack-as-you__");

    const attempts = await waitForAuditRows({
      probe: async () => {
        const rows = (await rowsSinceCursor(cursor, ["connector.refused"])).filter((r) => r.detail?.connection === "slack-as-you");
        return rows.length >= 2 ? rows : undefined;
      },
      label: "🔴 two connector.refused rows for the two searches (no row means the permission-proposal evidence has no source on eve 1.x)",
      actions: ["connector.refused"],
      cursor,
    });
    expect(attempts.map((r) => [r.detail?.reason, r.detail?.via]), "the rows carry some other reason or source than an ungranted search").toEqual(
      attempts.map(() => ["ungranted", "eve__search"]),
    );
    expect(
      (await rowsSinceCursor(cursor, ["connector.use", "connector.op", "connector.mint"])).filter(
        (r) => r.detail?.connection === "slack-as-you" || r.detail?.connector === "slack-as-you",
      ),
      "the evidence rows came with a use, an op or a mint: the search reached the connector",
    ).toEqual([]);

    const { permissionEvidence, makeWindow } = await import("@open-everywhere/core/agent/access/permission-evidence.js");
    const { proposePermissionChanges } = await import("@open-everywhere/core/agent/access/permission-proposal.js");
    const evidence = permissionEvidence(attempts, [], makeWindow(1, new Date(Date.now() + 60_000)));
    const found = evidence.refusals.find((r) => r.kind === "connector-refused" && r.connection === "slack-as-you");
    expect(found !== undefined && found.kind === "connector-refused" ? found.ungranted : 0, "🔴 the permission evidence does not count the two ungranted searches").toBe(2);
    expect(proposePermissionChanges(evidence, "widen").map((p) => p.id), "🔴 the proposal does not offer the slack-as-you grant").toContain(
      "widen:connector:ungranted:slack-as-you",
    );
  } finally {
    stub.uninstall();
  }
});
