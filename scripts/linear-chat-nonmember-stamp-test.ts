import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import {
  OE_CHAT_NONMEMBER_ATTR,
  defineSurface,
  registerSurfaces,
  _resetSurfacesForTest,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-linear-chat-nonmember-stamp-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.LINEAR_API_KEY = "linear-test-key";

const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
registerLinearProvider();
const { linearOnAgentSession, _resetLinearGuestCache } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

let guestAnswer: boolean | undefined;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fakeLinearGraphQL = (async (url: unknown, init: { body?: unknown }) => {
  const u = String(url);
  const body = String(init?.body ?? "");
  if (!u.includes("api.linear.app")) return resp(500, { error: "unexpected host" });
  if (body.includes("OeUserGuest")) {
    return guestAnswer === undefined ? resp(500, { error: "probe unavailable" }) : resp(200, { data: { user: { guest: guestAnswer } } });
  }
  return resp(200, { data: { agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } } });
}) as typeof fetch;

await withPatchedFetch(fakeLinearGraphQL, async () => {

const ORG = "taintorg";
const TEAM = "taint-team";
const SURFACE = `linear/${ORG}/${TEAM}`;

const event = (sessionId: string, creatorId: string): unknown => ({
  action: "created",
  kind: "agent_session",
  organizationId: ORG,
  previousComments: [],
  delivery: { id: `d-${sessionId}` },
  agentSession: { id: sessionId, creator: { id: creatorId }, issueId: "issue-1", issue: { id: "issue-1", identifier: "CAP-1" } },
  raw: { agentSession: { issue: { team: { id: TEAM } } } },
});

const driveAttrs = async (sessionId: string, creatorId: string, guest: boolean | undefined): Promise<Record<string, unknown> | undefined> => {
  guestAnswer = guest;
  _resetLinearGuestCache();
  const res = await linearOnAgentSession({} as never, event(sessionId, creatorId) as never);
  const auth = (res as { auth?: { attributes?: Record<string, unknown> } } | null)?.auth;
  return auth?.attributes;
};

const setDomains = (domains: readonly Domain[]) =>
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => domains, loadSilos: () => [], domainsForSurface: () => [],
  });

setDomains([{ name: "org", match: "org", externalPolicy: { authorGrain: "taint", roomGrain: "engage" } }]);

_resetSurfacesForTest();

const guest = await driveAttrs("as-guest", "guest-1", true);
ok(guest !== undefined, "author leg: a GUEST's session still DISPATCHES — taint marks the wake, it never drops it");
ok(
  guest?.[OE_CHAT_NONMEMBER_ATTR] === "true",
  "author leg: a workspace GUEST's session stamps oe_chat_nonmember on the dispatched auth",
);

const member = await driveAttrs("as-member", "member-1", false);
ok(member !== undefined, "author leg: a full MEMBER's session dispatches");
ok(
  member?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "author leg: a full MEMBER leaves oe_chat_nonmember ABSENT (negative control)",
);

const unresolved = await driveAttrs("as-unresolved", "unknown-1", undefined);
ok(
  unresolved?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "author leg: an UNRESOLVED guest probe leaves oe_chat_nonmember ABSENT (negative control — the leg fails OPEN)",
);

registerSurfaces([defineSurface({ key: SURFACE, trust: "public" })]);
const publicRoomMember = await driveAttrs("as-public-member", "member-1", false);
ok(
  publicRoomMember?.[OE_CHAT_NONMEMBER_ATTR] === "true",
  "room leg: a MEMBER's session on a team declared `public` stamps oe_chat_nonmember — anyone can type there",
);

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: SURFACE, trust: "internal" })]);

const internalRoomMember = await driveAttrs("as-internal-member", "member-1", false);
ok(
  internalRoomMember?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "room leg: a MEMBER on a team declared `internal` leaves oe_chat_nonmember ABSENT (negative control)",
);
const internalRoomGuest = await driveAttrs("as-internal-guest", "guest-1", true);
ok(
  internalRoomGuest?.[OE_CHAT_NONMEMBER_ATTR] === "true",
  "room leg: an `internal` declaration does NOT cancel the author leg — a GUEST on an internal team still marks",
);

});
_resetSurfacesForTest();
await removeTempDir(dir);
console.log(`\n✓ linear-chat-nonmember-stamp: ${n} assertions passed (author leg + room leg on the REAL ingress handler, with member/unresolved/internal-room negative controls)`);
