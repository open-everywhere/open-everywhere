import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_LISTED_CHANNEL_ID,
  registerScript,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const DISCORD_API = "https://discord.com/api/v10/";
const FIXTURE_TEXT = "ope2491 the meeting id is in the first post of this channel";
const GRANT_REFUSAL = "holds no discord work grant";

function installDiscordReadStub(): () => void {
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "DISCORD_BOT_TOKEN");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "integration-stub-discord-bot-token";
  const stub = installHostFetchStub(DISCORD_API, (url) => {
    if (!url.pathname.endsWith(`/channels/${DISCORD_LISTED_CHANNEL_ID}/messages`)) return undefined;
    return Response.json([
      {
        type: 0,
        id: "9000000000000002491",
        content: FIXTURE_TEXT,
        timestamp: "2026-10-17T10:00:00.000000+00:00",
        author: { id: "9000000000000000042", username: "alex", bot: false },
      },
    ]);
  });
  return () => {
    stub.uninstall();
    if (hadToken) process.env.DISCORD_BOT_TOKEN = previousToken;
    else delete process.env.DISCORD_BOT_TOKEN;
  };
}

async function pinNoDiscordGrant(): Promise<void> {
  const { loadDomains } = await import("../../../agent/memory/config/domains");
  const { domainHoldsSurfaceWorkGrant } = await import("@open-everywhere/core/agent/access/surface-work-grant.js");
  const home = loadDomains().find((d) => d.name === "e2e-unified");
  expect(home, "the e2e-unified domain is missing — this arm cannot measure the origin read").toBeDefined();
  expect(
    (home!.reach ?? []).some((c) => c.endsWith(`/${DISCORD_LISTED_CHANNEL_ID}`)),
    "e2e-unified no longer reaches the listed Discord channel",
  ).toBe(true);
  expect(domainHoldsSurfaceWorkGrant(home, "discord"), "e2e-unified now declares a Discord work role — the arm would pass on the grant, not on the origin").toBe(false);
  expect(domainHoldsSurfaceWorkGrant(home, "slack"), "control: e2e-unified still declares the Slack work role").toBe(true);
}

test("a Discord-woken worker on a domain with no Discord work grant holds and runs read_work_channel on its own channel", async () => {
  await bootAgent();
  await pinNoDiscordGrant();
  afterThisTest(installDiscordReadStub());
  const cursor = await auditCursor();

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "read the channel and find the meeting id" }, id: "ope2491-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: 120_000, calls: [{ tool: "read_work_channel", input: { limit: 5 }, id: "ope2491-work-read" }] }, { say: "found it" }],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> ope2491 what is the meeting id?" });

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the dispatch turn's receipt step");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, "ope2491-delegate", "the ope2491 delegation");
  handle.releaseHolds();

  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the worker's terminal step" });
  await awaitWorkResult({ handle: settlement, taskId, label: "the seat step that read the worker's result" });
  for (const h of [handle, settlement]) {
    expect(h.requests.filter((r) => r.fault !== undefined), "the scripted model reported a fault").toEqual([]);
    expect(h.resolves.filter((r) => r.fault !== undefined), "the scripted model reported a fault").toEqual([]);
  }

  const worker = handle.requests.find((r) => r.role === "child" && r.stepIndex === 0);
  expect(worker, "no worker request was recorded — the delegation never reached a child").toBeDefined();
  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(
      worker!.tools,
      `🔴 the Discord worker was NOT offered ${verb} on a domain with no Discord grant. It was offered [${worker!.tools.slice().sort().join(", ")}]`,
    ).toContain(verb);
  }
  for (const verb of ["read_channel", "read_thread"]) {
    expect(worker!.tools, `the worker was offered the seat's ${verb}`).not.toContain(verb);
  }
  const seat = handle.requests.find((r) => r.role === "parent")!;
  expect(seat.tools, "the seat's roster was not recorded at all").toContain("work");
  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(seat.tools, `🔴 the SEAT was offered ${verb}`).not.toContain(verb);
  }

  const read = (() => {
    for (const r of handle.requests) for (const t of r.toolResults) if (t.name === "read_work_channel") return t;
    return undefined;
  })();
  expect(read, "the worker never got a read_work_channel result at all").toBeDefined();
  const output = String(read!.output);
  expect(output, `🔴 the worker's own-origin read was refused by the grant. Got: ${output.slice(0, 300)}`).not.toContain(GRANT_REFUSAL);
  expect(output, `the worker's read did not return the channel's message. Got: ${output.slice(0, 300)}`).toContain(FIXTURE_TEXT);
}, 420_000);
