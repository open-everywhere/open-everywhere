import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OE_CHAT_NONMEMBER_ATTR,
  defineSurface,
  registerSurfaces,
  _resetSurfacesForTest,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-github-chat-nonmember-stamp-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
overrideSettingsForTest({ github: { appSlug: "eve-bot", conversation: true } });

const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
registerGithubProvider();
overrideSettingsForTest({ window: { topology: false } });
const { githubOnComment } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const OWNER = "taint-org";
const REPO = "taint-repo";
const SURFACE = `github/${OWNER}/${REPO}`;

const comment = (association: string | undefined, login: string): unknown => ({
  body: "@eve-bot please help",
  author: { login, id: 7, type: "User" },
  raw: association === undefined ? {} : { author_association: association },
});
const ctxFor = (): unknown => ({
  repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 1, private: true },
  conversation: { kind: "issue", issueNumber: 1, pullRequestNumber: null },
  github: { installationId: 123 },
  sender: { login: "someone", id: 7, type: "User" },
  thread: { kind: "issue", post: async () => ({ id: 1 }), react: async () => {} },
});

const driveAttrs = async (association: string | undefined, login: string): Promise<Record<string, unknown> | undefined> => {
  const res = await githubOnComment(ctxFor() as never, comment(association, login) as never);
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

const contributor = await driveAttrs("CONTRIBUTOR", "outsider");
ok(contributor !== undefined, "author leg: a CONTRIBUTOR's @mention still DISPATCHES — taint marks the wake, it never drops it");
ok(
  contributor?.[OE_CHAT_NONMEMBER_ATTR] === "true",
  "author leg: a CONTRIBUTOR's comment stamps oe_chat_nonmember on the dispatched auth",
);

const member = await driveAttrs("MEMBER", "insider");
ok(member !== undefined, "author leg: a MEMBER's @mention dispatches");
ok(
  member?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "author leg: a MEMBER's comment leaves oe_chat_nonmember ABSENT (negative control — an access grant is not a non-member)",
);

const collaborator = await driveAttrs("COLLABORATOR", "invited");
ok(
  collaborator?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "author leg: a COLLABORATOR's comment leaves oe_chat_nonmember ABSENT (negative control — an invited grant is internal)",
);

const absent = await driveAttrs(undefined, "unlabelled");
ok(
  absent?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "author leg: an ABSENT author_association leaves oe_chat_nonmember ABSENT (negative control — the leg fails OPEN)",
);

const unrecognised = await driveAttrs("SOMETHING_NEW", "future");
ok(
  unrecognised?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "author leg: an UNRECOGNISED association leaves oe_chat_nonmember ABSENT (negative control — a payload change must not start marking every turn)",
);

registerSurfaces([defineSurface({ key: SURFACE, trust: "public" })]);
const publicRoomMember = await driveAttrs("MEMBER", "insider");
ok(
  publicRoomMember?.[OE_CHAT_NONMEMBER_ATTR] === "true",
  "room leg: a MEMBER's comment in a repo declared `public` stamps oe_chat_nonmember — anyone can type there",
);

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: SURFACE, trust: "internal" })]);

const internalRoomMember = await driveAttrs("MEMBER", "insider");
ok(
  internalRoomMember?.[OE_CHAT_NONMEMBER_ATTR] === undefined,
  "room leg: a MEMBER's comment in a repo declared `internal` leaves oe_chat_nonmember ABSENT (negative control)",
);
const internalRoomContributor = await driveAttrs("CONTRIBUTOR", "outsider");
ok(
  internalRoomContributor?.[OE_CHAT_NONMEMBER_ATTR] === "true",
  "room leg: an `internal` declaration does NOT cancel the author leg — a CONTRIBUTOR in an internal repo still marks",
);

_resetSurfacesForTest();
await removeTempDir(dir);
console.log(`\n✓ github-chat-nonmember-stamp: ${n} assertions passed (author leg + room leg on the REAL ingress handler, with member/collaborator/absent/unrecognised/internal-room negative controls)`);
