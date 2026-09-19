import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import type { CredentialGrantAskRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";

import { auditCursor, bootAgent, rowsSinceCursor, runScheduleTask } from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const DISCORD_API = "https://discord.com/api/v10/";

const LAPSED_ROOM = "C-ope1112-lapsed-room";
const LAPSED_CARD_DM = "D-ope1112-lapsed-dm";
const LAPSED_CARD_MSG = "1112000000000000001";
const ANSWERED_ROOM = "C-ope1112-answered-room";
const STALE_ROOM = "C-ope1112-stale-room";
const STALE_CARD_DM = "D-ope1112-stale-dm";
const STALE_CARD_MSG = "1112000000000000003";
const ANSWERED_CARD_DM = "D-ope1112-answered-dm";
const ANSWERED_CARD_MSG = "1112000000000000002";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

function askRow(id: string, patch: Partial<CredentialGrantAskRow>): CredentialGrantAskRow {
  const created = new Date(Date.now() - 90 * 60_000).toISOString();
  return {
    connector: "notion",
    createdAt: created,
    expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    id,
    ownerNativeId: "U-ope1112-owner",
    ownerPlatform: "discord",
    ownerPrincipalId: "discord/G1/U-ope1112-owner",
    ownerSlug: "dana",
    purpose: "read the launch checklist",
    requestedMode: "once",
    frozenArgs: { page: "ope1112" },
    mcpTool: "notion-fetch",
    requesterPrincipalId: "discord/G1/U-ope1112-req",
    resource: "Launch checklist — notion-fetch({page:ope1112})",
    scopeKey: `session-${id}`,
    status: "pending",
    toolName: "grant__dana_notion__notion_fetch_launch_checklist",
    verb: "notion_fetch",
    ...patch,
  };
}

test("the compiled tidy cron task runs the credential-grant TTL sweep, and a lapsed ask tells BOTH sides", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const posts: { channelId: string; content: string }[] = [];
  const edits: { channelId: string; messageId: string; content: string }[] = [];
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "DISCORD_BOT_TOKEN");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "integration-stub-discord-bot-token";
  const discord = installHostFetchStub(DISCORD_API, (url, init) => {
    const path = url.href.slice(DISCORD_API.length);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { content?: string }) : {};
    const created = /^channels\/([^/]+)\/messages$/.exec(path);
    if (created && method === "POST") {
      posts.push({ channelId: created[1]!, content: body.content ?? "" });
      return new Response(JSON.stringify({ id: `posted-${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const edited = /^channels\/([^/]+)\/messages\/([^/]+)$/.exec(path);
    if (edited && method === "PATCH") {
      edits.push({ channelId: edited[1]!, messageId: edited[2]!, content: body.content ?? "" });
      return new Response(JSON.stringify({ id: edited[2] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return undefined;
  });
  cleanups.push(() => {
    discord.uninstall();
    if (hadToken) process.env.DISCORD_BOT_TOKEN = previousToken;
    else delete process.env.DISCORD_BOT_TOKEN;
  });

  const hadOrgs = Object.prototype.hasOwnProperty.call(process.env, "OE_TIDY_ORGS");
  const previousOrgs = process.env.OE_TIDY_ORGS;
  process.env.OE_TIDY_ORGS = org;
  cleanups.push(() => {
    if (hadOrgs) process.env.OE_TIDY_ORGS = previousOrgs;
    else delete process.env.OE_TIDY_ORGS;
  });

  const lapsed = askRow("ope1112-lapsed", {
    cardMessageId: LAPSED_CARD_MSG,
    cardSurfaceId: LAPSED_CARD_DM,
    requesterTarget: JSON.stringify({ channelId: LAPSED_ROOM, platform: "discord" }),
  });
  const stale = askRow("ope1112-stale", {
    cardMessageId: STALE_CARD_MSG,
    cardSurfaceId: STALE_CARD_DM,
    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 39 * 24 * 60 * 60_000).toISOString(),
    requesterTarget: JSON.stringify({ channelId: STALE_ROOM, platform: "discord" }),
  });

  const answered = askRow("ope1112-answered", {
    cardMessageId: ANSWERED_CARD_MSG,
    cardSurfaceId: ANSWERED_CARD_DM,
    decidedAt: new Date(Date.now() - 80 * 60_000).toISOString(),
    grantId: "grant-ope1112-answered",
    requesterTarget: JSON.stringify({ channelId: ANSWERED_ROOM, platform: "discord" }),
    status: "approved",
  });
  await store.addCredentialGrantAsk(org, lapsed);
  await store.addCredentialGrantAsk(org, stale);
  await store.addCredentialGrantAsk(org, answered);

  const spoof = process.env.OE_EGRESS_SPOOF;
  delete process.env.OE_EGRESS_SPOOF;
  try {
    await runScheduleTask("schedules/tidy.ts");
  } finally {
    if (spoof !== undefined) process.env.OE_EGRESS_SPOOF = spoof;
  }

  expect((await store.getCredentialGrantAsk(org, lapsed.id))?.status, "the compiled cron task must expire a pending ask past its TTL — a green unit test and a `pending` row here is exactly the defect OPE-1112 names").toBe(
    "expired",
  );
  expect((await store.getCredentialGrantAsk(org, answered.id))?.status, "NEGATIVE CONTROL: an ANSWERED ask past the same TTL is untouched — the sweep must read the status, not the clock alone").toBe("approved");
  expect((await store.getCredentialGrantAsk(org, stale.id))?.status, "a BACKLOG ask still goes terminal — the tidy-up half runs on every row, and only the two messages are withheld").toBe("expired");

  const lapseNotice = posts.find((p) => p.channelId === LAPSED_ROOM);
  expect(lapseNotice, `no lapse notice reached the requester's pinned conversation (posts: ${JSON.stringify(posts.map((p) => p.channelId))})`).toBeDefined();
  expect(lapseNotice?.content, "the lapse notice does not say what was asked for in a person's terms").toContain("read a Notion page");
  expect(lapseNotice?.content, "…and it does not carry the requester's own label for the page").toContain("Launch checklist");
  expect(lapseNotice?.content, "the vendor's tool id reached the requester's room").not.toContain("notion_fetch");
  expect(lapseNotice?.content, "…and so did its hyphenated spelling").not.toContain("notion-fetch");
  expect(lapseNotice?.content, "…and so did the minted tool name, which is built from the OWNER's platform id").not.toContain("grant__");
  expect(lapseNotice?.content, "the notice does not say the request expired").toContain("expired");
  expect(lapseNotice?.content, "the lapse notice must NOT read as a decline — nobody answered").toContain("did not decline");
  expect(posts.some((p) => p.channelId === ANSWERED_ROOM), "NEGATIVE CONTROL: the answered ask's room hears NOTHING — its owner already answered, and that answer was posted when they clicked").toBe(false);
  expect(
    posts.some((p) => p.channelId === STALE_ROOM),
    "NEGATIVE CONTROL: a room whose ask lapsed weeks ago hears NOTHING — the first tick after this ships must not blast the whole backlog at once",
  ).toBe(false);

  const cardEdit = edits.find((e) => e.channelId === LAPSED_CARD_DM);
  expect(cardEdit, `the owner's card was not rewritten (edits: ${JSON.stringify(edits.map((e) => e.channelId))})`).toBeDefined();
  expect(cardEdit?.messageId, "…and it must rewrite the card the delivery named, not some other message in the DM").toBe(LAPSED_CARD_MSG);
  expect(cardEdit?.content).toContain("EXPIRED");
  expect(edits.some((e) => e.channelId === ANSWERED_CARD_DM), "NEGATIVE CONTROL: the answered ask's card is left alone").toBe(false);
  expect(edits.some((e) => e.channelId === STALE_CARD_DM), "NEGATIVE CONTROL: nor is a backlog ask's card rewritten").toBe(false);

  const rows = await rowsSinceCursor(cursor, ["grant.expired"]);
  const mine = rows.filter((r) => r.detail?.["askId"] === lapsed.id);
  expect(mine.length, "the sweep must write exactly one `grant.expired` row for the lapsed ask").toBe(1);
  expect(mine[0]?.detail?.["cause"]).toBe("ttl");
  expect(mine[0]?.detail?.["notice"], "the audit row must record that the requester's notice actually landed").toBe("sent");
  expect(mine[0]?.detail?.["cardUpdated"], "…and that the owner's card was actually rewritten").toBe(true);
  expect(rows.some((r) => r.detail?.["askId"] === answered.id), "NEGATIVE CONTROL: no `grant.expired` row for the answered ask").toBe(false);
  const staleRow = rows.find((r) => r.detail?.["askId"] === stale.id);
  expect(staleRow, "a backlog ask still writes its terminal audit row — silence in the room is not silence in the trail").toBeDefined();
  expect(staleRow?.detail?.["notice"], "…marked `withheld_stale`, which is a different fact from a notice that failed or had nowhere to go").toBe("withheld_stale");
  expect(staleRow?.detail?.["cardUpdated"]).toBe(false);

  const postsAfterFirst = posts.length;
  const editsAfterFirst = edits.length;
  const spoofAgain = process.env.OE_EGRESS_SPOOF;
  delete process.env.OE_EGRESS_SPOOF;
  try {
    await runScheduleTask("schedules/tidy.ts");
  } finally {
    if (spoofAgain !== undefined) process.env.OE_EGRESS_SPOOF = spoofAgain;
  }
  expect(posts.length, "a second sweep pass must not post the lapse notice again").toBe(postsAfterFirst);
  expect(edits.length, "…nor rewrite the card again").toBe(editsAfterFirst);
});
