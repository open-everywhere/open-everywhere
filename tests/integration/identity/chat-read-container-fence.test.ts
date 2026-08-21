import { afterAll, expect, test } from "vitest";
import {
  awaitTaskSettlement,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const WAKE_CHANNEL_ID = "C0EXCHAN003";

const SIBLING_CHANNEL_ID = "C0EXRANDM";

const BOT_USER_ID = "U0BOTSELF01";
const BOT_ID = "B0BOTSELF01";
const MEMBER_USER_ID = "U0MEMBER001";

const WAKE_CONTAINER_TEXT = "ope929 wake-container message";
const SIBLING_TEXT = "ope929 SIBLING leak";

const READ_LIMIT = 7;

const channelKey = (platform: string, container: string): string => `ch_${Buffer.from(`${platform}:${container}`, "utf8").toString("base64url")}`;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

let stub: SlackWebApiStub | undefined;
let tsCounter = 100;

function userInfo(id: string, name: string): Record<string, unknown> {
  return { ok: true, user: { id, name, team_id: SLACK_TEAM_ID, real_name: name, profile: { display_name: name, real_name: name } } };
}

async function armSeams(): Promise<void> {
  await bootAgent();

  const { loadDomains } = await import("../../../agent/memory/domains");
  const wakeKey = `slack/${SLACK_TEAM_ID}/${WAKE_CHANNEL_ID}`;
  const siblingKey = `slack/${SLACK_TEAM_ID}/${SIBLING_CHANNEL_ID}`;
  const home = loadDomains().find((d) => (d.channels ?? []).includes(wakeKey));
  expect(home, `the wake channel ${wakeKey} is in no domain — this fixture cannot reach a window seat`).toBeDefined();
  expect(home?.mode, `${home?.name} is not a window domain, so a mention there reaches no delegating seat`).toBe("unified");
  expect(home?.ambientSupervisor, `${home?.name} must run an ambient supervisor for the mention divert to fire`).toBe(true);
  expect(home?.channels ?? [], `${siblingKey} must share ${home?.name} with the wake channel, else the allowlist masks the fence`).toContain(siblingKey);

  if (stub) return;
  const installed = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
      case "users.info": {
        const user = params.get("user") ?? "";
        if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, "ottobot");
        if (user === MEMBER_USER_ID) return userInfo(MEMBER_USER_ID, "ope929-member");
        return undefined;
      }
      case "conversations.info":
        return {
          ok: true,
          channel: {
            id: params.get("channel"),
            name: "it-ope929",
            is_channel: true,
            is_private: false,
            is_ext_shared: false,
            is_org_shared: false,
            is_shared: false,
            is_pending_ext_shared: false,
            num_members: 9,
          },
        };
      case "conversations.history": {
        const channel = params.get("channel") ?? "";
        const text = channel === WAKE_CHANNEL_ID ? WAKE_CONTAINER_TEXT : channel === SIBLING_CHANNEL_ID ? SIBLING_TEXT : undefined;
        if (text === undefined) return { ok: true, messages: [] };
        return { ok: true, messages: [{ type: "message", user: MEMBER_USER_ID, text, ts: "1700159720.000100" }] };
      }
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      default:
        return undefined;
    }
  });
  stub = installed;
  cleanups.push(() => installed.uninstall());
}

interface Driven {
  readonly handle: ScriptedHandle;
  readonly read: { readonly isError: boolean; readonly output: unknown };
}

async function driveOnce(): Promise<Driven> {
  await armSeams();
  const handle = disposeLater(
    registerScript({
      parent: [
        {
          calls: [
            {
              tool: "read_channel",
              input: { channel: channelKey("slack", SIBLING_CHANNEL_ID), limit: READ_LIMIT },
              id: "ope929-fence-read",
            },
          ],
        },
        { calls: [{ tool: "agent", input: { message: "take it from here" }, id: "ope929-fence-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ say: "reported" }],
    }),
  );

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackMentionWake({
    channelId: WAKE_CHANNEL_ID,
    userId: MEMBER_USER_ID,
    text: `<@${BOT_USER_ID}> ope929 please read this channel`,
    ts,
    eventId: `EvOpe929${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 2), "the seat's terminal step");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the worker's terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "the scripted model reported a fault").toEqual([]);

  let read: { readonly name: string; readonly isError: boolean; readonly output: unknown } | undefined;
  for (const r of handle.requests) for (const t of r.toolResults) if (t.name === "read_channel") read = t;
  expect(read, "the seat never got a read_channel result at all").toBeDefined();

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, "the ope929 delegation"),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: "the worker's settlement wake",
  });
  disposeLater(drained.handle);
  expect(drained.handle.requests.filter((r) => r.fault !== undefined), "a straggling worker crossed into the drain").toEqual([]);
  drained.handle.dispose();

  return { handle, read: { isError: read!.isError, output: read!.output } };
}

let once: Promise<Driven> | undefined;
function driven(): Promise<Driven> {
  return (once ??= driveOnce());
}

function readChannelDefinition(handle: ScriptedHandle): { readonly name: string; readonly inputSchema?: unknown } {
  const seat = handle.requests.find((r) => r.role === "parent");
  expect(seat, "no parent request was recorded at all").toBeDefined();
  const found = seat!.toolDefinitions.find((d) => d.name === "read_channel");
  expect(found, `the seat was not offered read_channel — it was offered [${seat!.tools.slice().sort().join(", ")}]`).toBeDefined();
  return found!;
}

function schemaProperties(schema: unknown): string[] {
  const props = (schema as { properties?: unknown } | undefined)?.properties;
  return typeof props === "object" && props !== null ? Object.keys(props as Record<string, unknown>) : [];
}

test("① the seat reads its WAKE CONTAINER — the tool offers no target, and a smuggled one moves nothing", async () => {
  const { handle, read } = await driven();

  const props = schemaProperties(readChannelDefinition(handle).inputSchema);
  expect(props, "read_channel's offered schema is unreadable, so the two assertions below are vacuous").toContain("limit");
  expect(props, "🔴 read_channel offers a target parameter again — the container fence is not structural").not.toContain("channel");
  expect(props, "read_channel must offer no thread/target parameter either").not.toContain("thread_ts");

  expect(read.isError, `the read failed: ${JSON.stringify(read.output).slice(0, 400)}`).toBe(false);
  const body = JSON.stringify(read.output);
  expect(body, "the result must name the WAKE container by its channel key").toContain(channelKey("slack", WAKE_CHANNEL_ID));
  expect(body, "the result must carry the wake container's own message").toContain(WAKE_CONTAINER_TEXT);

  expect(body, "🔴 the smuggled target was honoured — the read left its container").not.toContain(channelKey("slack", SIBLING_CHANNEL_ID));
  expect(body, "🔴 the model received another room's messages").not.toContain(SIBLING_TEXT);

  const history = stub!.calls.filter((c) => c.method === "conversations.history");
  expect(history.filter((c) => c.params.get("channel") === SIBLING_CHANNEL_ID), "no Slack read may name the smuggled channel").toEqual([]);

  const reads = history.filter((c) => c.params.get("limit") === String(READ_LIMIT));
  expect(reads.length, `exactly one conversations.history call carried limit=${READ_LIMIT}`).toBe(1);
  expect(reads[0]!.params.get("channel"), "the read fetched the WAKE container").toBe(WAKE_CHANNEL_ID);
}, 420_000);

test("② a delegated worker holds neither chat read — the seat holds both", async () => {
  const { handle } = await driven();

  const seat = handle.requests.find((r) => r.role === "parent")!;
  const worker = handle.requests.find((r) => r.role === "child");
  expect(worker, "no worker request was recorded — the delegation never reached a child").toBeDefined();

  for (const verb of ["read_channel", "read_thread"]) {
    expect(seat.tools, `the seat must hold ${verb} — it was offered [${seat.tools.slice().sort().join(", ")}]`).toContain(verb);
  }

  for (const verb of ["read_channel", "read_thread"]) {
    expect(worker!.tools, `🔴 the worker was offered ${verb} — the chat/work surface split is not enforced`).not.toContain(verb);
  }

  expect(worker!.tools, "the worker must hold the wide kit — this arm measures a subtraction, not a narrow seat").toContain("create_routine");
  expect(worker!.tools, "the worker must hold the wide kit").toContain("read_file_upload");
}, 420_000);
