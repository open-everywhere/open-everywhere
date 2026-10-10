import {
  buildNotionAuth,
  notionMode,
  notionVisibility,
  notionWorkspaceKey,
  type OpenEverywhereNotionAuth,
} from "../agent/channels/notion-identity.js";
import {
  bindFrom,
  registerSurfaces,
  defineSurface,
  _resetSurfacesForTest,
  type BindableContext,
  type SurfaceBinding,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionProvider } from "../agent/register.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";

registerNotionProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_resetDeploymentIdentityForTest();
for (const k of [
  "OE_PLATFORM",
  "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST",
]) {
  delete process.env[k];
}

function ctxFromAuth(auth: OpenEverywhereNotionAuth): BindableContext {
  return { channel: { kind: "notion" }, session: { auth: { current: auth } } };
}

const WS = "00000000-0000-4000-8000-00000000a0a1";
const PAGE = "00000000-0000-4000-8000-00000000b0b2";
const DISCUSSION = "00000000-0000-4000-8000-000000000001";
const COMMENT = "00000000-0000-4000-8000-00000000c0c3";
const AUTHOR = "00000000-0000-4000-8000-00000000d0d4";

function dispatch(): SurfaceBinding {
  const auth = buildNotionAuth({
    workspaceId: WS,
    pageId: PAGE,
    discussionId: DISCUSSION,
    commentId: COMMENT,
    principalId: AUTHOR,
  });
  return bindFrom(ctxFromAuth(auth));
}

ok(notionMode() === "channel", "notionMode is always channel (no DM primitive)");
ok(notionVisibility() === "private", "notionVisibility fails closed to private");
ok(notionWorkspaceKey(WS) === `notion/${WS}`, "notionWorkspaceKey is notion/<workspace id>");

const auth = buildNotionAuth({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION, commentId: COMMENT, principalId: AUTHOR });
ok(auth.authenticator === "notion", "auth.authenticator is notion");
ok(auth.principalId === AUTHOR, "auth.principalId is the comment author");
ok(auth.attributes.workspace_id === WS, "workspace_id stowed");
ok(auth.attributes.page_id === PAGE, "page_id stowed");
ok(auth.attributes.discussion_id === DISCUSSION, "discussion_id stowed");
ok(auth.attributes.comment_id === COMMENT, "comment_id stowed");
const bare = buildNotionAuth({ workspaceId: WS });
ok(bare.attributes.page_id === undefined && bare.principalId === "", "absent facts are omitted; principal empty when unknown");

_resetSurfacesForTest();
const b = dispatch();
ok(b.platform === "notion", "platform binds to notion");
ok(b.workspace === WS, "workspace = workspace_id");
ok(b.surface === PAGE, "surface = page_id (the silo grain, NOT the discussion/comment)");
ok(b.mode === "channel", "mode = channel");
ok(b.visibility === "private", "visibility FAILS CLOSED to private");
ok(b.trust === "external", "trust FAILS CLOSED to external (un-vouched real platform)");
ok(b.principalId === AUTHOR, "principal = comment author");

const PAY_CRED = "payments-channel-key";
const withCred = buildNotionAuth({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION, credentialId: PAY_CRED });
ok(withCred.attributes.credential_id === PAY_CRED, "credential_id stowed on the auth attributes");
const boundTarget = bindFrom(ctxFromAuth(withCred)).target as Record<string, unknown> | undefined;
ok(boundTarget?.credentialId === PAY_CRED, "bindNotion carries the delivery's credential onto the post-back target");
ok(boundTarget?.discussionId === DISCUSSION, "…without disturbing the reply anchor");
const noCredTarget = bindFrom(ctxFromAuth(buildNotionAuth({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION }))).target as Record<string, unknown> | undefined;
ok(noCredTarget?.credentialId === undefined, "a delivery that stowed NO credential leaves the target's credentialId absent (negative control)");

const noPage = bindFrom(ctxFromAuth(buildNotionAuth({ workspaceId: WS, discussionId: DISCUSSION })));
ok(noPage.surface === DISCUSSION, "surface falls back to discussion_id when page_id absent");
const onlyComment = bindFrom(ctxFromAuth(buildNotionAuth({ workspaceId: WS, commentId: COMMENT })));
ok(onlyComment.surface === COMMENT, "surface falls back to comment_id when page + discussion absent");

overrideSettingsForTest({ identity: { blanketTrust: "internal" } });
ok(dispatch().trust === "internal", "OE_TRUST=internal narrows the whole deployment to internal");
overrideSettingsForTest({ identity: { blanketTrust: "none" } });

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: notionWorkspaceKey(WS), trust: "internal" })]);
ok(dispatch().trust === "internal", "a per-workspace vouch (notionWorkspaceKey) narrows to internal");
ok(dispatch().surface === PAGE, "vouch does not disturb the surface");
_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: "notion/some-other-workspace", trust: "internal" })]);
ok(dispatch().trust === "external", "an unrelated workspace vouch leaves this surface external (fail-closed)");
_resetSurfacesForTest();

{
  const ROOT = "40000000000040008000000000000101";
  const stamped = buildNotionAuth({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION, trustRoot: ROOT });
  ok(stamped.attributes.trust_root === ROOT, "the matched trust root is stowed as the `trust_root` attribute");
  ok(bindFrom(ctxFromAuth(stamped)).trust === "internal", "🔴 a page under a declared trust root binds INTERNAL");
  ok(bindFrom(ctxFromAuth(stamped)).surface === PAGE, "…and the stamp does not disturb the surface");

  const unstamped = buildNotionAuth({ workspaceId: WS, pageId: PAGE, discussionId: DISCUSSION });
  ok(unstamped.attributes.trust_root === undefined, "an unmatched delivery stows NO trust_root");
  ok(bindFrom(ctxFromAuth(unstamped)).trust === "external", "🔴 no root, no promotion — the binding stays fail-closed external");

  registerSurfaces([defineSurface({ key: `notion/${WS}/${PAGE}`, trust: "public" })]);
  ok(bindFrom(ctxFromAuth(stamped)).trust === "external", "🔴 a `public` declaration on the page BEATS the ancestor-walk promotion");
  _resetSurfacesForTest();
  ok(bindFrom(ctxFromAuth(stamped)).trust === "internal", "…and with the declaration gone the promotion is back (the demotion was what refused)");
}

console.log(`\n✓ notion-identity: ${passed} assertions passed`);
