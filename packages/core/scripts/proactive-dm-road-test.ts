import { __setTestValveForTest } from "../agent/testing/test-valves.js";
import assert from "node:assert/strict";

import { adoptDelegatedAuthority } from "../agent/identity/delegated-binding.js";
import { bindFrom } from "../agent/identity/binding.js";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-proactive-dm-road-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;
__setTestValveForTest("egress-spoof", false);

import { registerGrantBorrowTransport } from "../agent/access/credential-grant-broker.js";
import { grantFooterPlace } from "../agent/access/credential-grant-card.js";
import { _resetGrantBorrowTransportsForTest } from "../agent/access/grant-borrow-transport-registry.internal.js";
import { approveCredentialGrant, askForCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { credentialGrantRefusalNote } from "../agent/access/credential-grant-ask.js";
import { setRegisteredConnectorCredentials, oauthConnectorHome } from "../agent/access/connector-credentials.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { fakeMcpServer } from "./_fake-mcp-server.js";
import { _resetMountedVariantsForTest, type MountedToolEntry, evaluateDynamic } from "../agent/access/window-gated.js";
import { recordRequesterIdentity } from "../agent/access/requester-identity.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import type { ReplierLabel, ReplyTarget } from "../agent/channels/reply-post.js";
import {
  deliverProactiveDm,
  DM_REFUSED_ACTION,
  dmDeliveryFooter,
  personAddress,
  readDmAudience,
  resumeDmAudience,
  stopDmAudience,
} from "../agent/channels/dm-audience.js";
import { PROACTIVE_DM_PLANES, proactiveDmPlaneRow } from "../agent/channels/proactive-dm-manifest.js";
import { registerSlackFixtureManifest, registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { FakeEveContext, inEveContext } from "./_eve-context-stub.js";
import type { BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import { readAudit } from "../agent/audit/audit.js";
import grantTools from "../agent/tools/grant_tools.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const NOW = Date.now();

const workerCtx = (sessionId: string): BindableContext =>
  ({
    channel: { kind: "unified", continuationToken: "unified:oe-dom:payments:oe-sup:g3" },
    session: {
      auth: {
        current: {
          attributes: { channel_id: "C-ROOM", oe_grain: "standing", oe_platform: "slack", oe_requester: "U-req", team_id: "T1", thread_ts: "1772633726.935000", trust_checked: "true" },
          principalId: "U-req",
          principalType: "slack-user",
        },
      },
      id: `worker-of-${sessionId}`,
      parent: { callId: "call-1", sessionId },
    },
  }) as unknown as BindableContext;

const seatCtx = (sessionId: string): BindableContext => {
  const c = workerCtx(sessionId) as unknown as { session: Record<string, unknown> };
  return { ...(c as object), session: { ...c.session, id: sessionId, parent: undefined } } as unknown as BindableContext;
};
const adoptSeatAuthority = (sessionId: string): void => {
  adoptDelegatedAuthority({ binding: bindFrom(seatCtx(sessionId)), nonMemberWake: false, requester: { kind: "requester", principalId: "U-req" } }, undefined);
};

const ENVELOPE = '<message trigger="true" from="human" author-id="slack/T1/U-req">read the granted page</message>';
const ORG = resolvePartition(seatCtx("probe")).org;
const stamps = { org: ORG, platform: "slack", surface: "slack/T1/C-ROOM", workspace: "T1" };

const BOB_ID = "U-owner";
const BOB = personAddress("slack", BOB_ID);
const bobSubject = { org: ORG, address: BOB, platform: "slack", workspace: "T1", principalId: BOB_ID };

registerSlackFixtureManifest();
registerSlackFixtureMapper();

const posted: string[] = [];
const dmed: DirectMessageRequest[] = [];
registerPostArm({
  displayNameCapable: true,
  dispatchReply: async (_target: ReplyTarget, text: string, _replier?: ReplierLabel): Promise<string> => {
    posted.push(text);
    return `ts-${posted.length}`;
  },
  resolveTarget: (bag: { str(k: string): string | undefined; readonly threadTs?: string }): ReplyTarget | null => {
    const channelId = bag.str("channelId");
    return channelId === undefined ? null : { channelId, platform: "slack", threadTs: bag.threadTs };
  },
  deliverDirectMessage: async (input: DirectMessageRequest) => {
    dmed.push(input);
    return { messageId: `dm-${dmed.length}`, surfaceId: "D-owner" };
  },
  platform: "slack",
});

_resetMountedVariantsForTest();

const MCP_URL = "https://mcp.notion.com/mcp";
const VENDOR_TOOL = "notion-fetch";
setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: oauthConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });
const vendor = fakeMcpServer({
  tools: [{ inputSchema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" }, name: VENDOR_TOOL }],
});
const BORROW_DEPS = { fetch: vendor.fetch, mintOwnerToken: async (): Promise<string> => "OWNER-TOKEN" };

const calls: string[] = [];
_resetGrantBorrowTransportsForTest();
registerGrantBorrowTransport(
  "notion",
  async (call) => {
    calls.push(call.mcpTool);
    return { blocks: ["one", "two"] };
  },
  "test:proactive-dm-road",
);

const askInput = (scopeKey: string, mode: "once" | "session" | "standing") => ({
  ...stamps,
  connector: "notion",
  domainGrantsConnector: true,
  explicit: false,
  nowMs: NOW,
  ownerHandle: "Bob Stone",
  ownerNativeId: BOB_ID,
  ownerPlatform: "slack",
  ownerPrincipalId: "slack/T1/U-owner",
  purpose: "draft the Q3 summary",
  requestedMode: mode,
  requesterLabel: "Ada",
  requesterPrincipalId: "slack/T1/U-req",
  frozenArgs: { id: "abc123" },
  mcpTool: VENDOR_TOOL,
  scopeKey,
  targetLabel: "Launch page",
});

const callThroughMount = async (scopeKey: string): Promise<{ ok: boolean }> => {
  const ctx = workerCtx(scopeKey);
  return inEveContext(new FakeEveContext(), async () => {
    adoptSeatAuthority(scopeKey);
    recordRequesterIdentity(ctx, undefined, ENVELOPE);
    const mounted = (await evaluateDynamic(grantTools, ctx)) as Record<string, MountedToolEntry> | null;
    const entry = mounted?.["grant__bob_stone_notion__notion_fetch_launch_page"];
    assert.ok(entry !== undefined, "the mount projected the granted tool");
    return (await entry.execute({ id: "abc123" }, ctx)) as { ok: boolean };
  });
};

type AuditRow = { readonly action: string; readonly detail?: unknown };
const rowsWhere = async (action: string, pick: (d: Record<string, unknown>) => boolean): Promise<AuditRow[]> =>
  (await readAudit({ org: ORG })).filter((r) => r.action === action && pick((r.detail ?? {}) as Record<string, unknown>));

const footerFor = (container: string, requesterLabel?: string): string =>
  dmDeliveryFooter({ platform: "slack", recipientId: BOB_ID, requestedBy: "slack/T1/U-req", ...(requesterLabel !== undefined ? { requesterLabel } : {}), ...grantFooterPlace(container, undefined) });
const STOP_SENTENCE = "Reply here to ask me to stop and I will not start another DM with you.";

console.log("1. Bob stops, then Ada asks to borrow Bob's credential:");
{
  await stopDmAudience({ ...bobSubject, at: new Date(NOW).toISOString() });
  ok((await readDmAudience(ORG, BOB)).stopped, "Bob's stop is recorded on his own person address");

  const before = dmed.length;
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  let ask: Awaited<ReturnType<typeof askForCredentialGrant>>;
  try {
    ask = await askForCredentialGrant({ ...askInput("session-stopped", "session"), domainScopeKey: "oe-grant-domain::stop-test" });
  } finally {
    console.warn = realWarn;
  }
  const cardWarns = warned.filter((l) => l.includes("grant card DM to"));
  ok(cardWarns.length === 1, `🔴 OPE-2063: the undelivered card logs exactly one warn line (got ${String(cardWarns.length)})`);
  ok(
    cardWarns[0]?.includes("slack/T1/U-owner") === true && cardWarns[0]?.includes("(owner_stopped_dms)") === true,
    `…naming the owner key and the refusal reason (got ${String(cardWarns[0])})`,
  );
  ok(!ask.sent, "the ask is REFUSED — no grant card was sent to a person who asked the agent to stop");
  ok(ask.sent === false && ask.reason === "owner_unreachable", `the refusal reason is owner_unreachable (got ${JSON.stringify(ask)})`);
  ok(dmed.length === before, `NOTHING reached Bob's DM (the arm was called ${String(dmed.length - before)} time(s))`);

  const refusals = await rowsWhere(DM_REFUSED_ACTION, (d) => d.plane === "credential.grant.card");
  ok(refusals.length === 1, `exactly one ${DM_REFUSED_ACTION} row names the credential.grant.card plane (found ${String(refusals.length)})`);
  const detail = (refusals[0]!.detail ?? {}) as Record<string, unknown>;
  ok(detail.boundary === "stopped", `the row names the BOUNDARY as the recipient's stop (got ${String(detail.boundary)})`);
  ok(detail.target === BOB_ID, `the row names the person it refused (got ${String(detail.target)})`);
  ok(detail.grant === BOB, `the row names the address the stop is keyed on (got ${String(detail.grant)})`);

  const grantRefusals = await rowsWhere("grant.refused", (d) => d.gate === "owner_unreachable");
  ok(grantRefusals.length === 1, "the grant plane files its own refusal row too — the ask is closed, not left pending");
  ok(
    ((grantRefusals[0]!.detail ?? {}) as Record<string, unknown>).reason === "owner_stopped_dms",
    `that row carries the STOP as the reason, so an operator can tell it from a missing DM arm (got ${String(((grantRefusals[0]!.detail ?? {}) as Record<string, unknown>).reason)})`,
  );
  const unreachable = (grantRefusals[0]?.detail ?? {}) as Record<string, unknown>;
  ok(unreachable.scopeKey === "session-stopped", `🔴 OPE-2063: the owner_unreachable row carries the session's scopeKey (got ${String(unreachable.scopeKey)})`);
  ok(unreachable.domainScopeKey === "oe-grant-domain::stop-test", `…and the domainScopeKey (got ${String(unreachable.domainScopeKey)})`);
  ok(unreachable.owner === "slack/T1/U-owner", `…and the owner key that was asked (got ${String(unreachable.owner)})`);
}

console.log("2. the requester's answer:");
{
  const note = credentialGrantRefusalNote("notion", "owner_unreachable");
  ok(note.length > 0, "the requester is TOLD — an ask that was refused never returns silence");
  ok(note.includes("cannot send that person a direct message"), "the note says the owner cannot be reached by direct message");
  for (const leak of ["stop", "stopped", "blocked", "opted out", "asked the agent"]) {
    ok(!note.toLowerCase().includes(leak), `the note does NOT disclose the owner's own boundary ("${leak}" is absent)`);
  }
}

console.log("3. Bob lifts his stop:");
let grantScope = "";
{
  await resumeDmAudience(bobSubject);
  ok(!(await readDmAudience(ORG, BOB)).stopped, "Bob's stop is lifted");

  const before = dmed.length;
  const ask = await askForCredentialGrant({ ...askInput("session-live", "session"), domainScopeKey: "oe-grant-domain::stop-test" });
  ok(ask.sent, `the SAME ask now goes out (got ${JSON.stringify(ask)})`);
  ok(dmed.length === before + 1, "exactly one card reached Bob's DM");
  const card = dmed[dmed.length - 1]!;
  ok(card.principalId === BOB_ID, "the card went to Bob");
  ok((card.actions ?? []).length === 4, "the card kept its four tappable answers — the road carries actions through");
  ok(footerFor("session-live", "Ada").includes(STOP_SENTENCE), "the host footer really carries the stop sentence — without this the two assertions below are vacuous");
  ok(card.text.endsWith(footerFor("session-live", "Ada")), "the card carries the host footer that tells Bob how to stop these messages");
  ok(card.text.endsWith("_Ada asked for this in another conversation. " + STOP_SENTENCE + "_"), `the card's footer reads in words (got ${JSON.stringify(card.text.slice(-160))})`);
  ok(!card.text.includes("slack/T1/U-req") && !card.text.includes("session-live"), "the card names no principal key and no grant scope key");
  ok(!(await readDmAudience(ORG, BOB)).delivered, "the grant card does NOT spend the chat.dm DELIVERY RECORD");
  await deliverProactiveDm({
    where: { org: ORG, platform: "slack", workspace: "T1", surface: "slack/T1/C-ROOM" },
    plane: "chat.dm",
    platform: "slack",
    recipientId: BOB_ID,
    address: BOB,
    text: "A message the model wrote.",
    footer: footerFor("slack/T1/C-ROOM"),
    requestedBy: "slack/T1/U-req",
    attributedTo: "slack/T1/U-req",
    first: true,
  });
  ok((await readDmAudience(ORG, BOB)).delivered, "…and a chat.dm delivery to the SAME person DOES spend it — so the absence above is a fact about the plane, not about the harness");
  ok(dmed.at(-1)?.generated === true, "🔴 OPE-2542: a chat.dm delivery reaches the arm marked generated — the model wrote it");
  ok(card.generated === undefined, "🔴 OPE-2542: the grant card reaches the arm with NO generated flag — host copy carries no AI label");

  const approved = await approveCredentialGrant(stamps, ask.sent ? ask.askId : "", "session", "slack/T1/U-owner", NOW + 500, undefined, BORROW_DEPS);
  ok(approved.approved, "Bob approves, and a live grant exists");
  grantScope = "session-live";
}

console.log("4. Bob stops again, then his credential is used:");
{
  await stopDmAudience({ ...bobSubject, at: new Date(NOW + 1000).toISOString() });
  const beforeDms = dmed.length;
  const beforeCalls = calls.length;
  const beforePosts = posted.length;

  const ran = await callThroughMount(grantScope);
  ok(ran.ok, "the granted call still RUNS — a stop refuses the DM, it does not revoke the grant");
  ok(calls.length === beforeCalls + 1, "the vendor call really went out");
  ok(posted.length > beforePosts, "the room still gets its host-authored disclosure line");
  ok(dmed.length === beforeDms, `NO first-use notice reached Bob (the arm was called ${String(dmed.length - beforeDms)} time(s))`);

  const refusals = await rowsWhere(DM_REFUSED_ACTION, (d) => d.plane === "credential.grant.notice");
  ok(refusals.length === 1, `one ${DM_REFUSED_ACTION} row names the credential.grant.notice plane (found ${String(refusals.length)})`);
  ok(((refusals[0]!.detail ?? {}) as Record<string, unknown>).boundary === "stopped", "…and names the stop as the boundary");
}

console.log("5. Bob lifts his stop again, and the notice he never got arrives on the next use:");
{
  await resumeDmAudience(bobSubject);
  const beforeDms = dmed.length;
  const ran = await callThroughMount(grantScope);
  ok(ran.ok, "a second granted call runs on the same session grant");
  ok(dmed.length === beforeDms + 1, `the first-use notice NOW arrives — the claim was never spent (arm called ${String(dmed.length - beforeDms)} time(s))`);
  const notice = dmed[dmed.length - 1]!;
  ok(notice.principalId === BOB_ID, "the notice went to Bob");
  ok(notice.text.endsWith(footerFor(grantScope)), "the notice carries the host footer that tells Bob how to stop these messages");
}

console.log("6. the plane manifest:");
{
  const planes = PROACTIVE_DM_PLANES.map((r) => r.plane);
  ok(new Set(planes).size === planes.length, "every plane is declared exactly once");
  for (const row of PROACTIVE_DM_PLANES) {
    ok(row.modules.length > 0, `${row.plane} names the module(s) that emit it`);
    ok(row.what.trim().length > 0, `${row.plane} says what the person receives`);
    if (row.stop === "exempt") {
      ok((row.exemptBecause ?? "").trim().length > 0, `${row.plane} is exempt, so it must carry the REASON a reviewer weighs`);
      ok(!row.recordsDelivery, `${row.plane} is off the road, so it cannot be writing the chat.dm delivery record`);
    } else {
      ok(row.exemptBecause === undefined, `${row.plane} takes the road, so it carries no exemption reason to go stale`);
    }
  }
  const records = PROACTIVE_DM_PLANES.filter((r) => r.recordsDelivery).map((r) => r.plane);
  assert.deepStrictEqual(records, ["chat.dm"], "chat.dm is the ONLY plane that writes the delivery record");
  n++;
}

console.log("7. no plane bypasses the road:");
{
  const ROOT = resolve(import.meta.dirname, "../../..");
  const ROAD = ["packages/core/agent/channels/dm-audience.ts", "packages/core/agent/channels/post-arms.ts"];
  const declared = new Set([...ROAD, ...PROACTIVE_DM_PLANES.filter((r) => r.stop === "exempt").flatMap((r) => r.modules)]);

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist" || e === "docs") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.includes("-test.ts") && !p.endsWith(".test.ts")) files.push(p);
    }
  };
  for (const root of ["packages/core/agent", "packages/providers"]) walk(join(ROOT, root));
  ok(files.length > 200, `the walk really found the source tree (${String(files.length)} files)`);

  const isComment = (line: string): boolean => {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  };
  const isDeclaration = (line: string): boolean => /^\s*deliverDirectMessage\s*[?:]/u.test(line);

  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (declared.has(rel)) continue;
    const hits = readFileSync(file, "utf8")
      .split("\n")
      .map((line, i) => ({ i: i + 1, line }))
      .filter(({ line }) => /(?<![A-Za-z])(deliverDirectMessage|dispatchDirectMessage)/u.test(line))
      .filter(({ line }) => !isComment(line) && !isDeclaration(line));
    for (const h of hits) offenders.push(`${rel}:${String(h.i)}`);
  }
  ok(
    offenders.length === 0,
    `every DM emitter takes the road, or is a module of an EXEMPT plane row. BYPASSING THE ROAD: ${offenders.join(", ")}. ` +
      `Route it through deliverProactiveDm, or add its module to an exempt plane row in agent/channels/proactive-dm-manifest.ts with the reason. ` +
      `A module already on an "outranks" row is NOT excused here — a plane on the road must not open a second one beside it, which is how OPE-1855 happened.`,
  );

  for (const row of PROACTIVE_DM_PLANES) {
    for (const mod of row.modules) {
      const body = readFileSync(join(ROOT, mod), "utf8");
      const live = body
        .split("\n")
        .some((line) => !isComment(line) && !isDeclaration(line) && /(?<![A-Za-z])(deliverDirectMessage|dispatchDirectMessage|deliverProactiveDm|assertProactiveDmAllowed)/u.test(line));
      ok(live, `${row.plane}: ${mod} still emits a direct message — a row naming a module that does not is a stale exemption`);
    }
  }
}

{
  const RULED_EXEMPT = ["identity.link-set", "identity.link-consent", "governance.pane"] as const;

  for (const plane of RULED_EXEMPT) {
    const row = proactiveDmPlaneRow(plane);
    ok(
      row.stop === "exempt",
      `🔴 §8/OPE-1868: ${plane} is EXEMPT from the recipient's stop — the ruling is that an important or host-originated message stays exempt. Losing this row forces the plane onto the road, where the stop then silences that message`,
    );
    ok(
      typeof row.exemptBecause === "string" && row.exemptBecause.length > 0,
      `§8: ${plane} states WHY it is exempt — an exemption a reviewer cannot weigh is the oversight this table exists to prevent`,
    );
  }

  const RULED_ON_THE_ROAD = ["chat.dm", "credential.grant.card", "credential.grant.notice", "credential.grant.consent"] as const;
  for (const plane of RULED_ON_THE_ROAD) {
    const row = proactiveDmPlaneRow(plane);
    ok(
      row.stop === "outranks",
      `🔴 §8/OPE-1868 NEGATIVE CONTROL: ${plane} carries somebody else's errand, so the recipient's stop OUTRANKS it. An exemption here excuses its modules from §7's scan, which is the OPE-1855 defect returning with nothing left to catch it`,
    );
    ok(row.exemptBecause === undefined, `§8: ${plane} carries no exemption reason, because it has no exemption to explain`);
  }

  const exempt = PROACTIVE_DM_PLANES.filter((r) => r.stop === "exempt").map((r) => r.plane);
  ok(
    exempt.length === RULED_EXEMPT.length && RULED_EXEMPT.every((p) => exempt.includes(p)),
    `🔴 §8/OPE-1868: EXACTLY these planes are exempt — ${RULED_EXEMPT.join(", ")}. Saw: ${exempt.join(", ") || "none"}. A new exemption is a ruling, so it changes this list in the same commit that argues for it`,
  );
  ok(
    PROACTIVE_DM_PLANES.every((r) => r.stop === "exempt" || r.stop === "outranks"),
    "§8: every plane takes one of the two standings — the table admits no third state",
  );
}

{
  const RULED_GENERATED = ["chat.dm", "attention.blocked"] as const;
  const generated = PROACTIVE_DM_PLANES.filter((r) => r.generated).map((r) => r.plane);
  ok(
    generated.length === RULED_GENERATED.length && RULED_GENERATED.every((p) => generated.includes(p)),
    `🔴 §9/OPE-2542: EXACTLY these planes carry model text — ${RULED_GENERATED.join(", ")}. Saw: ${generated.join(", ") || "none"}. dm_person's text and the blocked ping's status line are the model's; every other plane is host copy`,
  );
  ok(
    PROACTIVE_DM_PLANES.every((r) => typeof r.generated === "boolean"),
    "§9: every plane answers `generated` — a plane with no answer cannot reach the road",
  );
  ok(
    PROACTIVE_DM_PLANES.every((r) => !r.generated || r.stop === "outranks"),
    "🔴 §9: only a plane ON THE ROAD can carry `generated` — an exempt plane calls the post arm itself, so the row's flag would label nothing",
  );
}

console.log(`✓ proactive-dm-road: ${String(n)} assertions`);
