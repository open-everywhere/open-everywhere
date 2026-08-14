import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readAudit, resolvePartition, _resetSurfacesForTest } from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";

const dir = join(tmpdir(), `open-everywhere-github-external-policy-author-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.GITHUB_APP_SLUG = "eve-bot";

const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
registerGithubProvider();
const { githubOnComment, githubExternalVerdict } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { buildGitHubAuth } = await import("@open-everywhere/provider-github/agent/channels/github-identity.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const OWNER = "plain-org";
const REPO = "plain-repo";
const part = resolvePartition({
  channel: { kind: "github" as const },
  session: {
    auth: {
      current: buildGitHubAuth({ owner: OWNER, repo: REPO, actorLogin: "someone", conversationKind: "issue", issueNumber: 1 }) as unknown as {
        attributes?: Readonly<Record<string, string>>;
      },
    },
  },
} as never);

const comment = (association: string | undefined, login: string): unknown => ({
  body: "@eve-bot please help",
  author: { login, id: 7, type: "User" },
  raw: association === undefined ? {} : { author_association: association },
});
const ctxFor = (posted: string[]): unknown => ({
  repository: { owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}`, id: 1, private: true },
  conversation: { kind: "issue", issueNumber: 1, pullRequestNumber: null },
  github: { installationId: 123 },
  sender: { login: "someone", id: 7, type: "User" },
  thread: { kind: "issue", post: async (t: string) => { posted.push(t); return { id: 1 }; }, react: async () => {} },
});
const drive = async (association: string | undefined, login: string) => {
  const posted: string[] = [];
  const res = await githubOnComment(ctxFor(posted) as never, comment(association, login) as never);
  return { res, posted };
};
const suppressedRows = async () =>
  (await readAudit({ org: part.org, action: "github.external_policy_suppressed" })).filter((r) => r.surface === part.surfaceKey);

const setDomains = (domains: readonly Domain[]) =>
  registerConfig({
    loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
    loadDomains: () => domains, loadSilos: () => [], domainsForSurface: () => [],
  });

setDomains([{ name: "org", match: "org", externalPolicy: { authorGrain: "withhold" } }]);

const excluded = await drive("CONTRIBUTOR", "outsider");
ok(excluded.res === null, "author grain: a CONTRIBUTOR under `withhold` is SILENTLY DROPPED (returns null)");
ok(excluded.posted.length === 0, "author grain: NO comment is posted — GitHub has no private channel back to the commenter");
const rows1 = await suppressedRows();
ok(
  rows1.length === 1 && rows1[0]!.detail?.verdict === "withheld-author",
  "author grain: ONE github.external_policy_suppressed audit row names the surface with verdict withheld-author",
);
ok(rows1[0]!.principalId === "outsider", "author grain: the audit row names the excluded author");

const member = await drive("MEMBER", "insider");
ok(
  member.res !== null && (member.res as { auth?: unknown }).auth !== undefined,
  "author grain: a MEMBER under the SAME `withhold` policy DISPATCHES (negative control — an access grant is internal)",
);
ok((await suppressedRows()).length === 1, "author grain: the MEMBER comment writes NO further suppression row");

const collaborator = await drive("COLLABORATOR", "invited");
ok(
  collaborator.res !== null && (collaborator.res as { auth?: unknown }).auth !== undefined,
  "author grain: a COLLABORATOR under `withhold` DISPATCHES (negative control — an invited grant is internal)",
);

const unknownAssociation = await drive(undefined, "unlabelled");
ok(
  unknownAssociation.res !== null && (unknownAssociation.res as { auth?: unknown }).auth !== undefined,
  "author grain: an ABSENT author_association under `withhold` DISPATCHES (negative control — fail open)",
);
ok((await suppressedRows()).length === 1, "author grain: neither negative control writes a suppression row");

setDomains([]);
const shippedDefault = await drive("CONTRIBUTOR", "outsider");
ok(
  shippedDefault.res !== null && (shippedDefault.res as { auth?: unknown }).auth !== undefined,
  "author grain: the SAME CONTRIBUTOR DISPATCHES under the shipped `taint` default (negative control — an upgrade changes nothing)",
);
ok((await suppressedRows()).length === 1, "author grain: the shipped default writes NO suppression row");

setDomains([{ name: "org", match: "org", externalPolicy: { roomGrain: "silent" } }]);
const guestPresent = await drive("CONTRIBUTOR", "outsider");
ok(guestPresent.res === null, "room grain: a refuted author makes the UNDECLARED room external under `silent` — the wake is dropped");
const rows3 = await suppressedRows();
ok(
  rows3.length === 2 && rows3.some((r) => r.detail?.verdict === "silent-room"),
  "room grain: the GUEST-PRESENT verdict is recorded as silent-room, not as an author verdict",
);
const memberInSilentRoom = await drive("MEMBER", "insider");
ok(
  memberInSilentRoom.res !== null && (memberInSilentRoom.res as { auth?: unknown }).auth !== undefined,
  "room grain: a MEMBER in the SAME undeclared room under `silent` DISPATCHES (negative control — no external leg holds)",
);
ok((await suppressedRows()).length === 2, "room grain: the member comment writes NO suppression row");

const refuted = { refuted: true } as const;
ok(
  githubExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "silent" }, author: refuted, surfaceKey: `github/${OWNER}/${REPO}` }) === "withheld-author",
  "order: an excluded author under BOTH grains is a withheld-author verdict, not a silent-room one",
);
ok(
  githubExternalVerdict({ policy: { authorGrain: "taint", roomGrain: "silent" }, author: refuted, surfaceKey: `github/${OWNER}/${REPO}` }) === "silent-room",
  "order: with the author grain shipped, the SAME refuted author still answers silent-room via the room leg",
);
ok(
  githubExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "engage" }, author: refuted, surfaceKey: `github/${OWNER}/${REPO}` }) === "withheld-author",
  "order: the author grain answers with the room grain shipped",
);
ok(
  githubExternalVerdict({ policy: { authorGrain: "withhold", roomGrain: "silent" }, author: {}, surfaceKey: `github/${OWNER}/${REPO}` }) === "proceed",
  "order: an unrefuted author in an undeclared room proceeds under BOTH grains armed (negative control)",
);

_resetSurfacesForTest();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ github-external-policy-author: ${n} assertions passed (author_association exclusion + guest-present room leg, with member/collaborator/absent/shipped-default negative controls)`);
