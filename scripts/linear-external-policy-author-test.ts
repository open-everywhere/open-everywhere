import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { readAudit, resolvePartition, _resetSurfacesForTest } from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";

const dir = join(tmpdir(), `open-everywhere-linear-external-policy-author-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.LINEAR_API_KEY = "linear-test-key";

const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
registerLinearProvider();
const { linearOnAgentSession, linearExternalVerdict, _resetLinearGuestCache } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface FetchCall {
  readonly url: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let guestAnswer: boolean | undefined;
let issueTeamAnswer: { readonly teamId: string; readonly isPrivate: boolean } | undefined;
const issueTeamQueries = () => calls.filter((c) => c.body.includes("OeIssueTeam")).length;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fakeLinearGraphQL = (async (url: unknown, init: { body?: unknown }) => {
  const u = String(url);
  const body = String(init?.body ?? "");
  calls.push({ url: u, body });
  if (!u.includes("api.linear.app")) return resp(500, { error: "unexpected host" });
  if (body.includes("OeUserGuest")) {
    return guestAnswer === undefined ? resp(500, { error: "probe unavailable" }) : resp(200, { data: { user: { guest: guestAnswer } } });
  }
  if (body.includes("OeIssueTeam")) {
    return resp(200, {
      data: { issue: issueTeamAnswer === undefined ? null : { team: { id: issueTeamAnswer.teamId, private: issueTeamAnswer.isPrivate } } },
    });
  }
  return resp(200, { data: { agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } } });
}) as typeof fetch;

await withPatchedFetch(fakeLinearGraphQL, async () => {

const ORG = "orglin";
const TEAM = "plain-team";
const part = resolvePartition({
  channel: { kind: "linear" as const },
  session: { auth: { current: { attributes: { organization_id: ORG, team_id: TEAM }, principalId: "creator-1", principalType: "linear-user" } } },
} as never);

const event = (sessionId: string, creatorId: string): unknown => ({
  action: "created",
  kind: "agent_session",
  organizationId: ORG,
  previousComments: [],
  delivery: { id: `d-${sessionId}` },
  agentSession: { id: sessionId, creator: { id: creatorId }, issueId: "issue-1", issue: { id: "issue-1", identifier: "CAP-1" } },
  raw: { agentSession: { issue: { team: { id: TEAM } } } },
});
const drive = async (sessionId: string, creatorId: string, guest: boolean | undefined) => {
  calls = [];
  guestAnswer = guest;
  _resetLinearGuestCache();
  const res = await linearOnAgentSession({} as never, event(sessionId, creatorId) as never);
  return { res, posted: calls.filter((c) => c.url.includes("api.linear.app")).map((c) => c.body) };
};
const suppressedRows = async () =>
  (await readAudit({ org: part.org, action: "linear.external_policy_suppressed" })).filter((r) => r.surface === part.surfaceKey);

const setDomains = (domains: readonly Domain[]) =>
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => domains, loadSilos: () => [], domainsForSurface: () => [],
  });

setDomains([{ name: "org", match: "org", externalPolicy: { authorGrain: "withhold" } }]);

const guest = await drive("as-guest", "guest-1", true);
ok(guest.res === null, "author grain: a workspace GUEST under `withhold` is SILENTLY DROPPED (returns null)");
ok(
  !guest.posted.some((b) => b.includes("AgentActivityCreate")),
  "🔴 OPE-884 author grain: a withheld author's mention creates NO Agent Activity of any type",
);
const rows1 = await suppressedRows();
ok(
  rows1.length === 1 && rows1[0]!.detail?.verdict === "withheld-author",
  "author grain: ONE linear.external_policy_suppressed audit row names the surface with verdict withheld-author",
);
ok(rows1[0]!.principalId === "guest-1", "author grain: the audit row names the excluded author");
ok(
  !guest.posted.some((b) => b.includes("external space")),
  "author grain: nothing written claims the ROOM is external — the person decided it, not the place",
);
ok(
  !guest.posted.some((b) => b.includes("no reply")),
  "🔴 OPE-884 author grain: no outcome text is written either — the session is left to age out rather than announce a person's classification",
);

const member = await drive("as-member", "member-1", false);
ok(
  member.res !== null && (member.res as { auth?: unknown }).auth !== undefined,
  "author grain: a full MEMBER under the SAME `withhold` policy DISPATCHES (negative control)",
);
ok((await suppressedRows()).length === 1, "author grain: the member session writes NO further suppression row");

const unresolved = await drive("as-unresolved", "unknown-1", undefined);
ok(
  unresolved.res !== null && (unresolved.res as { auth?: unknown }).auth !== undefined,
  "author grain: an UNRESOLVED guest probe under `withhold` DISPATCHES (negative control — fail open)",
);
ok((await suppressedRows()).length === 1, "author grain: neither negative control writes a suppression row");

setDomains([]);
const shippedDefault = await drive("as-shipped", "guest-1", true);
ok(
  shippedDefault.res !== null && (shippedDefault.res as { auth?: unknown }).auth !== undefined,
  "author grain: the SAME guest DISPATCHES under the shipped `taint` default (negative control — an upgrade changes nothing)",
);
ok((await suppressedRows()).length === 1, "author grain: the shipped default writes NO suppression row");

setDomains([{ name: "org", match: "org", externalPolicy: { roomGrain: "silent" } }]);
const guestPresent = await drive("as-guest-present", "guest-1", true);
ok(guestPresent.res === null, "room grain: a refuted author makes the UNDECLARED room external under `silent` — the mention is dropped");
const rows3 = await suppressedRows();
ok(
  rows3.length === 2 && rows3.some((r) => r.detail?.verdict === "silent-room"),
  "room grain: the GUEST-PRESENT verdict is recorded as silent-room, not as an author verdict",
);
ok(
  !guestPresent.posted.some((b) => b.includes("AgentActivityCreate")),
  "🔴 OPE-884 room grain: the GUEST-PRESENT verdict writes NO Agent Activity either — the verdict lives in the audit row alone",
);
const memberInSilentRoom = await drive("as-member-silent", "member-1", false);
ok(
  memberInSilentRoom.res !== null && (memberInSilentRoom.res as { auth?: unknown }).auth !== undefined,
  "room grain: a MEMBER in the SAME undeclared team under `silent` DISPATCHES (negative control — no external leg holds)",
);
ok((await suppressedRows()).length === 2, "room grain: the member session writes NO suppression row");

const refutedAuthor = { refuted: true } as const;
const SURFACE = `linear/${ORG}/${TEAM}`;
ok(
  linearExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "silent" }, surfaceKey: SURFACE, author: refutedAuthor }) === "withheld-author",
  "order: an excluded author under BOTH grains is a withheld-author verdict, not a silent-room one",
);
ok(
  linearExternalVerdict({ policy: { authorGrain: "taint", roomGrain: "silent" }, surfaceKey: SURFACE, author: refutedAuthor }) === "silent-room",
  "order: with the author grain shipped, the SAME guest still answers silent-room via the room leg",
);
ok(
  linearExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "silent" }, surfaceKey: SURFACE }) === "proceed",
  "order: with NO author resolved yet, an undeclared team proceeds under BOTH grains armed",
);
ok(
  linearExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "silent" }, surfaceKey: SURFACE, author: {} }) === "proceed",
  "order: an unrefuted author in an undeclared team proceeds under BOTH grains armed (negative control)",
);

const eventNoTeam = (sessionId: string, creatorId: string): unknown => ({
  action: "created",
  kind: "agent_session",
  organizationId: ORG,
  previousComments: [],
  delivery: { id: `d-${sessionId}` },
  agentSession: { id: sessionId, creator: { id: creatorId }, issueId: "issue-1", issue: { id: "issue-1", identifier: "CAP-1" } },
  raw: { agentSession: { issue: {} } },
});
const driveNoTeam = async (sessionId: string, creatorId: string, guest: boolean | undefined) => {
  calls = [];
  guestAnswer = guest;
  _resetLinearGuestCache();
  const res = await linearOnAgentSession({} as never, eventNoTeam(sessionId, creatorId) as never);
  return { res, posted: calls.filter((c) => c.url.includes("api.linear.app")).map((c) => c.body) };
};
const roomlessRows = async () =>
  (await readAudit({ org: part.org, action: "linear.external_policy_suppressed" })).filter((r) => r.surface === undefined);

setDomains([{ name: "org", match: "org", externalPolicy: { authorGrain: "withhold" } }]);
const noTeamGuest = await driveNoTeam("as-noteam-guest", "guest-1", true);
ok(
  noTeamGuest.res === null,
  "OPE-541: a GUEST under `withhold` is SILENTLY DROPPED even when the team id does NOT parse (the author grain needs no room)",
);
ok(
  !noTeamGuest.posted.some((b) => b.includes("AgentActivityCreate")),
  "OPE-541/OPE-884: the roomless suppression creates NO Agent Activity either",
);
const rows5 = await roomlessRows();
ok(
  rows5.length === 1 && rows5[0]!.detail?.verdict === "withheld-author" && rows5[0]!.principalId === "guest-1",
  "OPE-541: ONE suppression row records verdict withheld-author and names the excluded author",
);
ok(rows5[0]!.workspace === ORG, "OPE-541: the roomless row still names the WORKSPACE — only the team was unreadable");
ok(
  !noTeamGuest.posted.some((b) => b.includes("external space")),
  "OPE-541: nothing written claims a room this delivery could not name",
);

const noTeamMember = await driveNoTeam("as-noteam-member", "member-1", false);
ok(
  noTeamMember.res !== null && (noTeamMember.res as { auth?: unknown }).auth !== undefined,
  "OPE-541: a full MEMBER on the SAME unparseable-team event DISPATCHES (negative control)",
);
ok((await roomlessRows()).length === 1, "OPE-541: the member session writes NO roomless suppression row");

const noTeamUnresolved = await driveNoTeam("as-noteam-unresolved", "unknown-1", undefined);
ok(
  noTeamUnresolved.res !== null && (noTeamUnresolved.res as { auth?: unknown }).auth !== undefined,
  "OPE-541: an UNRESOLVED guest probe on an unparseable-team event DISPATCHES (negative control — fail open)",
);
ok((await roomlessRows()).length === 1, "OPE-541: neither negative control writes a roomless suppression row");

setDomains([{ name: "org", match: "org", externalPolicy: { roomGrain: "silent" } }]);
const noTeamRoomSilent = await driveNoTeam("as-noteam-room", "guest-1", true);
ok(
  noTeamRoomSilent.res !== null && (noTeamRoomSilent.res as { auth?: unknown }).auth !== undefined,
  "OPE-541: under `roomGrain: \"silent\"` ALONE the unparseable-team wake PROCEEDS — the room leg needs a key and never guesses one",
);
ok((await roomlessRows()).length === 1, "OPE-541: the room leg writes NO roomless suppression row");
ok(
  issueTeamQueries() === 1,
  "OPE-543: the issue→team resolution WAS attempted on the unparseable-team wake — it stood down because the API resolved no team",
);

ok(
  linearExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "silent" }, author: refutedAuthor }) === "withheld-author",
  "OPE-541: with NO surfaceKey an excluded author is still a withheld-author verdict",
);
ok(
  linearExternalVerdict({ policy: { authorGrain: "taint", roomGrain: "silent" }, author: refutedAuthor }) === "proceed",
  "OPE-541: with NO surfaceKey the SAME refuted author under `silent` proceeds — the room leg cannot fire without a key (negative control)",
);

const RESOLVED_TEAM = "resolved-team";
const RESOLVED_SURFACE = `linear/${ORG}/${RESOLVED_TEAM}`;
const resolvedRows = async () =>
  (await readAudit({ org: part.org, action: "linear.external_policy_suppressed" })).filter((r) => r.surface === RESOLVED_SURFACE);
issueTeamAnswer = { teamId: RESOLVED_TEAM, isPrivate: true };

setDomains([{ name: "org", match: "org", externalPolicy: { roomGrain: "silent" } }]);
const resolvedGuest = await driveNoTeam("as-resolved-room", "guest-1", true);
ok(
  resolvedGuest.res === null,
  "OPE-543: with the team RESOLVED off the issue id, the guest-present room leg fires under `silent` — the wake is dropped (Phase 5 proceeded on the same event)",
);
const rows6 = await resolvedRows();
ok(
  rows6.length === 1 && rows6[0]!.detail?.verdict === "silent-room",
  "OPE-543: ONE suppression row records verdict silent-room — a ROOM verdict, not an author one",
);
ok(
  rows6[0]!.surface === RESOLVED_SURFACE,
  "OPE-543: the row names the room key built from the RESOLVED team, so the grain keyed on the hop's answer",
);
ok(
  (await roomlessRows()).length === 1,
  "OPE-543: no roomless row was written — this delivery could name its room (negative control against a silent stand-down)",
);
ok(
  issueTeamQueries() === 1,
  "OPE-543: ONE issue→team hop served the whole wake — the room check, the privacy read and the binding all read the shared verdict",
);

const resolvedMember = await driveNoTeam("as-resolved-member", "member-1", false);
ok(
  resolvedMember.res !== null && (resolvedMember.res as { auth?: unknown }).auth !== undefined,
  "OPE-543: a full MEMBER on the SAME resolved-team event DISPATCHES (negative control — a room key is not a suppression)",
);
ok((await resolvedRows()).length === 1, "OPE-543: the member session writes NO further suppression row");

const resolvedReplay = await driveNoTeam("as-resolved-member", "member-1", false);
ok(
  resolvedReplay.res !== null && (resolvedReplay.res as { auth?: unknown }).auth !== undefined,
  "OPE-543: the replayed delivery still dispatches (the memo returns the same verdict)",
);
ok(
  issueTeamQueries() === 0,
  "OPE-543: the SECOND read of one delivery makes ZERO issue→team queries — the hop runs at most once per delivery",
);
issueTeamAnswer = undefined;

});
_resetSurfacesForTest();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ linear-external-policy-author: ${n} assertions passed (guest exclusion + guest-present room leg + the roomless author grain + the resolved room key, with member/unresolved/shipped-default negative controls)`);
