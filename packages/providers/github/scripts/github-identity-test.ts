import { bindFrom, resolvePartition, type BindableContext } from "@open-everywhere/core/agent/adapter-api.js";
import {
  buildGitHubAuth,
  githubAssociationRefutes,
  githubAuthorFacts,
  githubBotMentioned,
  githubVisibility,
  githubTrust,
  GITHUB_EXTERNAL_ASSOCIATIONS,
  GITHUB_INTERNAL_ASSOCIATIONS,
} from "../agent/channels/github-identity.js";
import { registerGithubProvider } from "../agent/register.js";

registerGithubProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function githubCtx(attributes: Record<string, string>, principalId?: string): BindableContext {
  return {
    channel: { kind: "github" },
    session: { auth: { current: { attributes, principalId: principalId ?? "", principalType: "github-user" } } },
  };
}

ok(githubVisibility("false") === "public", "github: repo_private=false -> public");
ok(githubVisibility("true") === "private", "github: repo_private=true -> private");
ok(githubVisibility(undefined) === "private", "github: FAIL-CLOSED unknown privacy -> private");

ok(githubTrust("true", "OWNER") === "internal", "githubTrust: private repo + OWNER -> internal");
ok(githubTrust("true", "MEMBER") === "internal", "githubTrust: private repo + MEMBER -> internal");
ok(githubTrust("true", "COLLABORATOR") === undefined, "githubTrust: private repo + COLLABORATOR (maybe outside) -> no verdict (binds external)");
ok(githubTrust("true", "CONTRIBUTOR") === undefined, "githubTrust: private repo + CONTRIBUTOR -> no verdict");
ok(githubTrust("true", "NONE") === undefined, "githubTrust: private repo + NONE -> no verdict");
ok(githubTrust("true", undefined) === undefined, "githubTrust: FAIL-CLOSED missing association -> no verdict");
ok(githubTrust("false", "OWNER") === undefined, "githubTrust: PUBLIC repo -> no verdict even for OWNER (world-readable, external contributors)");
ok(githubTrust(undefined, "OWNER") === undefined, "githubTrust: FAIL-CLOSED unknown privacy -> no verdict");

ok(githubBotMentioned("hey @my-bot please look", "my-bot", { login: "alice", type: "User" }), "github mention: @bot in body -> wake");
ok(!githubBotMentioned("hey @my-botanist", "my-bot", { login: "alice", type: "User" }), "github mention: @my-botanist is NOT @my-bot (word-boundary)");
ok(!githubBotMentioned("no mention here", "my-bot", { login: "alice", type: "User" }), "github mention: no @bot -> no wake");
ok(!githubBotMentioned("@my-bot help", "my-bot", { login: "someone", type: "Bot" }), "github mention: bot author ignored (loop guard)");
ok(!githubBotMentioned("@my-bot help", "my-bot", { login: "my-bot[bot]", type: "User" }), "github mention: the bot's own comment ignored");
ok(!githubBotMentioned("@my-bot <!-- eve:github: x -->", "my-bot", { login: "alice", type: "User" }), "github mention: eve marker comment ignored");
ok(!githubBotMentioned("@my-bot help", undefined, { login: "alice", type: "User" }), "github mention: no botName -> no wake");
ok(githubBotMentioned("@My-Bot hi", "my-bot", undefined), "github mention: case-insensitive + undefined author tolerated");

const ghPriv = bindFrom(githubCtx({ owner: "acme", repo: "widgets", repo_private: "true", conversation_kind: "issue", issue_number: "7", author_association: "OWNER", user_login: "octo", user_id: "42" }, "octo"));
ok(ghPriv.platform === "github" && ghPriv.workspace === "acme" && ghPriv.surface === "widgets", "github: workspace=owner, surface=repo (issue is the anchor, not the silo)");
ok(ghPriv.mode === "channel", "github: sessions are channel-mode (no DM analog)");
ok(ghPriv.visibility === "private" && ghPriv.trust === "internal", "github: private repo + OWNER -> private/internal");
ok(ghPriv.principalId === "octo", "github: principalId from auth principal / user_login");
ok(JSON.stringify(ghPriv.target) === JSON.stringify({ owner: "acme", repo: "widgets", issueNumber: 7 }), "github: issue post-back target = { owner, repo, issueNumber }");

const ghPub = bindFrom(githubCtx({ owner: "acme", repo: "oss", repo_private: "false", conversation_kind: "pull_request", pull_request_number: "12", author_association: "OWNER", user_login: "octo" }));
ok(ghPub.visibility === "public", "github: public repo -> visibility public");
ok(ghPub.trust === "external", "github: public repo -> trust fails closed to external (world-readable)");
ok(JSON.stringify(ghPub.target) === JSON.stringify({ owner: "acme", repo: "oss", pullRequestNumber: 12 }), "github: PR post-back target = { owner, repo, pullRequestNumber }");

const ghReview = bindFrom(githubCtx({ owner: "acme", repo: "widgets", repo_private: "true", conversation_kind: "review_thread", pull_request_number: "9", issue_number: "9", author_association: "MEMBER", user_login: "rev" }));
ok(JSON.stringify(ghReview.target) === JSON.stringify({ owner: "acme", repo: "widgets", pullRequestNumber: 9 }), "github: review_thread anchors to pullRequestNumber (not issueNumber)");

const ghA = bindFrom(githubCtx({ owner: "acme", repo: "widgets", issue_number: "1", user_login: "u" }));
const ghB = bindFrom(githubCtx({ owner: "acme", repo: "widgets", issue_number: "2", user_login: "u" }));
ok(ghA.surface === ghB.surface && ghA.surface === "widgets", "github: distinct issues in one repo share the repo surface silo");

const ghUnknown = bindFrom(githubCtx({ owner: "acme", repo: "widgets", conversation_kind: "issue", issue_number: "3", user_login: "stranger", author_association: "NONE" }));
ok(ghUnknown.visibility === "private" && ghUnknown.trust === "external", "github: unknown repo privacy -> FAIL-CLOSED private/external");

const ghPart = resolvePartition(githubCtx({ owner: "acme", repo: "widgets", issue_number: "7", user_login: "u" }));
ok(ghPart.surfaceKey === "github/acme/widgets", "github: partition surfaceKey = platform/owner/repo");

const ga = buildGitHubAuth({ owner: "acme", repo: "widgets", repositoryFullName: "acme/widgets", repositoryId: 5, isPrivate: true, conversationKind: "issue", issueNumber: 7, installationId: 99, actorLogin: "octo", actorId: 42, actorType: "User", authorAssociation: "OWNER" });
ok(ga.authenticator === "github" && ga.principalId === "octo" && ga.principalType === "github-user", "buildGitHubAuth: principal fields");
ok(ga.attributes.owner === "acme" && ga.attributes.repo === "widgets" && ga.attributes.repo_private === "true" && ga.attributes.author_association === "OWNER" && ga.attributes.issue_number === "7", "buildGitHubAuth: facts captured as strings");
const gaBot = buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "dependabot[bot]", actorType: "Bot" });
ok(gaBot.principalType === "service", "buildGitHubAuth: Bot actor -> service principal");
const gaSparse = buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "u" });
ok(gaSparse.attributes.repo_private === undefined && gaSparse.attributes.issue_number === undefined && gaSparse.attributes.author_association === undefined, "buildGitHubAuth: omits unknown facts (no false claims)");

for (const a of GITHUB_INTERNAL_ASSOCIATIONS) {
  ok(githubAssociationRefutes(a) === false, `author grain: ${a} holds an access grant -> NOT refuted`);
  ok(githubAuthorFacts({ authorAssociation: a }).refuted === undefined, `author grain: ${a} carries no refutation to the core`);
}
for (const a of GITHUB_EXTERNAL_ASSOCIATIONS) {
  ok(githubAssociationRefutes(a) === true, `author grain: ${a} holds no access grant -> REFUTED`);
  ok(githubAuthorFacts({ authorAssociation: a }).refuted === true, `author grain: ${a} carries refuted:true to the core`);
}
ok(GITHUB_INTERNAL_ASSOCIATIONS.length === 3 && GITHUB_EXTERNAL_ASSOCIATIONS.length === 5, "author grain: the sets hold 3 internal + 5 external values");
ok(
  GITHUB_INTERNAL_ASSOCIATIONS.every((a) => !GITHUB_EXTERNAL_ASSOCIATIONS.includes(a)),
  "author grain: no value is in both sets",
);
ok(GITHUB_INTERNAL_ASSOCIATIONS.includes("COLLABORATOR"), "author grain: COLLABORATOR is INTERNAL (a deliberate access grant)");
ok(GITHUB_EXTERNAL_ASSOCIATIONS.includes("CONTRIBUTOR"), "author grain: CONTRIBUTOR is EXTERNAL (a past merged PR is not an access grant)");
ok(GITHUB_EXTERNAL_ASSOCIATIONS.includes("MANNEQUIN"), "author grain: MANNEQUIN is EXTERNAL (an import placeholder with no live person)");

ok(githubAssociationRefutes(undefined) === false, "author grain: an ABSENT association does NOT refute (fail open)");
ok(githubAssociationRefutes("") === false, "author grain: an EMPTY association does NOT refute");
ok(githubAssociationRefutes("SOME_FUTURE_VALUE") === false, "author grain: an UNRECOGNISED association does NOT refute (fail open)");
ok(githubAssociationRefutes("contributor") === false, "author grain: a lower-case variant does NOT refute (the vendor enum has one spelling)");

const botFacts = githubAuthorFacts({ authorAssociation: "NONE", actorType: "Bot" });
ok(botFacts.trust === "relay" && botFacts.refuted === undefined, "author grain: a Bot actor grades `relay` and carries NO refutation");
const humanFacts = githubAuthorFacts({ authorAssociation: "NONE", actorType: "User" });
ok(humanFacts.refuted === true && humanFacts.trust === undefined, "author grain: a User actor with NONE is refuted, with NO invented trust tier");

console.log(`✓ github-identity: ${passed} assertions passed`);
