// proves: github.external_policy_suppressed

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit, resolvePartition, _resetSurfacesForTest, EXTERNAL_MENTION_ACK } from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-github-external-policy-author-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
overrideSettingsForTest({ github: { appSlug: "eve-bot", conversation: true } });

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
ok(excluded.res === null, "author grain: a CONTRIBUTOR under `withhold` is DROPPED before any turn (returns null)");
ok(
  excluded.posted.length === 1 && excluded.posted[0] === EXTERNAL_MENTION_ACK,
  "🔴 OPE-885: a suppressed EXPLICIT @mention gets EXACTLY the fixed host ack, posted through eve's own thread.post",
);
ok(
  !/outsider|CONTRIBUTOR|organisation|guest|polic/i.test(excluded.posted[0]!),
  "🔴 OPE-885: the ack names no author, no association, no organisation and no policy — a public repo's comments are world-readable",
);
const rows1 = await suppressedRows();
ok(
  rows1.length === 1 && rows1[0]!.detail?.verdict === "withheld-author",
  "author grain: ONE github.external_policy_suppressed audit row names the surface with verdict withheld-author",
);
ok(rows1[0]!.detail?.rendering === "ack", "🔴 OPE-885: the suppression row records rendering:\"ack\" — an operator can tell a member-visible drop from an invisible one");
ok(rows1[0]!.principalId === "outsider", "author grain: the audit row names the excluded author");

{
  const res = await githubOnComment(
    { ...(ctxFor([]) as Record<string, unknown>), thread: { kind: "issue", post: async () => { throw new Error("GitHub 403"); }, react: async () => {} } } as never,
    comment("CONTRIBUTOR", "outsider2") as never,
  );
  ok(res === null, "OPE-885: a failed ack still drops the wake");
  const rows = await suppressedRows();
  ok(rows.length === 2, "OPE-885: the failed-ack drop still writes its suppression row");
  ok(
    rows.find((r) => r.principalId === "outsider2")!.detail?.rendering === undefined,
    "🔴 OPE-885: a REFUSED ack writes NO rendering field (=== undefined) — the row never claims a post that did not land",
  );
}

const member = await drive("MEMBER", "insider");
ok(
  member.res !== null && (member.res as { auth?: unknown }).auth !== undefined,
  "author grain: a MEMBER under the SAME `withhold` policy DISPATCHES (negative control — an access grant is internal)",
);
ok((await suppressedRows()).length === 2, "author grain: the MEMBER comment writes NO further suppression row");

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
ok((await suppressedRows()).length === 2, "author grain: neither negative control writes a suppression row");

setDomains([{ name: "org", match: "org", externalPolicy: { authorGrain: "taint", roomGrain: "engage" } }]);
const optOut = await drive("CONTRIBUTOR", "outsider");
ok(
  optOut.res !== null && (optOut.res as { auth?: unknown }).auth !== undefined,
  "author grain: the SAME CONTRIBUTOR DISPATCHES under the `taint` / `engage` opt-out (negative control — the opt-out restores the old behaviour)",
);
ok((await suppressedRows()).length === 2, "author grain: the opt-out writes NO suppression row");

setDomains([{ name: "org", match: "org", externalPolicy: { authorGrain: "taint", roomGrain: "silent" } }]);
const guestPresent = await drive("CONTRIBUTOR", "outsider");
ok(guestPresent.res === null, "room grain: a refuted author makes the UNDECLARED room external under `silent` — the wake is dropped");
const rows3 = await suppressedRows();
ok(
  rows3.length === 3 && rows3.some((r) => r.detail?.verdict === "silent-room"),
  "room grain: the GUEST-PRESENT verdict is recorded as silent-room, not as an author verdict",
);
ok(
  guestPresent.posted.length === 1 && guestPresent.posted[0] === EXTERNAL_MENTION_ACK,
  "🔴 OPE-885: a SILENCED ROOM's explicit @mention gets the SAME fixed line as the withheld-author leg — one string, so a reader cannot tell which grain fired",
);
ok(
  rows3.find((r) => r.detail?.verdict === "silent-room")!.detail?.rendering === "ack",
  "OPE-885: the silent-room suppression row records rendering:\"ack\" too",
);
const memberInSilentRoom = await drive("MEMBER", "insider");
ok(
  memberInSilentRoom.res !== null && (memberInSilentRoom.res as { auth?: unknown }).auth !== undefined,
  "room grain: a MEMBER in the SAME undeclared room under `silent` DISPATCHES (negative control — no external leg holds)",
);
ok((await suppressedRows()).length === 3, "room grain: the member comment writes NO suppression row");

setDomains([]);
const shippedExcluded = await drive("CONTRIBUTOR", "outsider");
ok(shippedExcluded.res === null, "🔴 shipped default: a CONTRIBUTOR's @mention is DROPPED with no declaration at all — `withhold` ships");
ok(
  shippedExcluded.posted.length === 1 && shippedExcluded.posted[0] === EXTERNAL_MENTION_ACK,
  "shipped default: the dropped @mention gets the one fixed ack, so the mentioning person does not read the agent as broken",
);
ok((await suppressedRows()).length === 4, "shipped default: the drop writes its suppression row");
const shippedMember = await drive("MEMBER", "insider");
ok(
  shippedMember.res !== null && (shippedMember.res as { auth?: unknown }).auth !== undefined,
  "🔴 shipped default: a MEMBER in the same undeclared repo DISPATCHES (negative control — a member's own message is not withheld)",
);
ok((await suppressedRows()).length === 4, "shipped default: the member comment writes NO suppression row");

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
await removeTempDir(dir);
console.log(`\n✓ github-external-policy-author: ${n} assertions passed (author_association exclusion + guest-present room leg, with member/collaborator/absent/shipped-default negative controls)`);
