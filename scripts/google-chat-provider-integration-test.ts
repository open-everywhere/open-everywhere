import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { exportPKCS8, generateKeyPair } from "jose";

const dir = join(tmpdir(), `open-everywhere-google-chat-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
const kp = await generateKeyPair("RS256", { extractable: true });
process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: "service_account", client_email: "it@p.iam.gserviceaccount.com", private_key: await exportPKCS8(kp.privateKey) });

const { registerGoogleChatProvider } = await import("@open-everywhere/provider-google-chat/agent/register.js");
const { isOperatorSecretName } = await import("@open-everywhere/core/agent/ops/operator-secret-roster.js");
const { buildGoogleChatAuth } = await import("@open-everywhere/provider-google-chat/agent/channels/google-chat-identity.js");
const { googleChatPolicy, registerGoogleChatPolicy } = await import("@open-everywhere/provider-google-chat/agent/policy.js");
const { capabilitiesForPlatform, bindFrom, supportedReadPlatforms, wakeOriginCodec, surfaceMessageOps } = await import("@open-everywhere/core/agent/adapter-api.js");
const { postArm } = await import("@open-everywhere/core/agent/channels/post-arms.js");
const { isUnifiedWakeOrigin, unifiedThreadRef, wakeBindingMatchesOrigin, isWakeSurfaceBinding } = await import("@open-everywhere/core/agent/channels/unified-window.js");
const { postUnifiedReply } = await import("@open-everywhere/core/agent/channels/unified-reply.js");
const { surfaceParityFor } = await import("@open-everywhere/core/agent/identity/surface-parity.js");
import type { UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  passed++;
};

await import("../agent/google-chat/policy.js");
ok(googleChatPolicy().enabled === false && googleChatPolicy().audience === null, "the app's Google Chat policy registers and ships OFF");

registerGoogleChatProvider();
ok(capabilitiesForPlatform("google-chat").midTurnPost === true, "the manifest arms `reply` on Google Chat");
ok(capabilitiesForPlatform("google-chat").reactions === false, "the manifest arms no reactions on Google Chat");
ok(typeof postArm("google-chat")?.dispatchUnified === "function", "the post arm is registered");
ok(postArm("google-chat")?.editMessage === undefined, "the post arm registers no edit (not built yet)");
ok(wakeOriginCodec("google-chat") !== undefined, "the wake-origin codec is registered");
ok(surfaceMessageOps("google-chat") !== undefined, "the host-notice transport is registered");
ok(isOperatorSecretName("GOOGLE_CHAT_SERVICE_ACCOUNT_KEY"), "the service-account key is on the operator-secret roster (adopt_env_secrets accepts it)");
ok(!supportedReadPlatforms().includes("google-chat"), "no read adapter is registered (the app cannot list a space)");
ok(surfaceParityFor("google-chat") !== undefined, "the surface parity declaration is registered");

type GoogleChatOrigin = Extract<UnifiedWakeOrigin, { platform: "google-chat" }>;
const origin: GoogleChatOrigin = { platform: "google-chat", workspace: "acme", space: "spaces/AAAA", thread: "spaces/AAAA/threads/t1", messageName: "spaces/AAAA/messages/m1" };
ok(isUnifiedWakeOrigin(origin), "a stored Google Chat origin validates through core");
ok(!isUnifiedWakeOrigin({ ...origin, thread: "spaces/BBBB/threads/t1" }), "an origin whose thread belongs to another space does not validate");
ok(unifiedThreadRef(origin).threadKey === "spaces/AAAA/threads/t1", "the thread ref is the codec's");

const auth = buildGoogleChatAuth({ workspace: "acme", space: "spaces/AAAA", mode: "channel", trust: "internal", sender: "users/111", thread: "spaces/AAAA/threads/t1", messageName: "spaces/AAAA/messages/m1" });
const ctx = (a: typeof auth) => ({ channel: { kind: "google-chat" }, session: { auth: { current: a as never } } });
const binding = bindFrom(ctx(auth));
ok(binding.platform === "google-chat" && binding.workspace === "acme" && binding.surface === "AAAA", "bindFrom resolves the binding through the registered mapper");
ok(binding.visibility === "private" && binding.trust === "internal" && binding.mode === "channel", "the binding is private, with the front's trust");
ok(wakeBindingMatchesOrigin(binding, origin), "the binding matches the origin it was frozen beside");
ok(!wakeBindingMatchesOrigin(binding, { ...origin, space: "spaces/BBBB", thread: "spaces/BBBB/threads/t1" }), "an origin for another space does not match");
ok(!wakeBindingMatchesOrigin(binding, { ...origin, thread: "spaces/AAAA/threads/t2" }), "an origin for another thread does not match");
ok(!wakeBindingMatchesOrigin(binding, { ...origin, workspace: "other" }), "an origin for another workspace does not match");
ok(isWakeSurfaceBinding(JSON.parse(JSON.stringify(binding))), "the binding survives the durable frozen-binding grammar");
const externalAuth = { ...auth, attributes: { ...auth.attributes, gchat_trust: "external" } };
const { registerSurfaces, defineSurface } = await import("@open-everywhere/core/agent/identity/trust.js");
registerSurfaces([defineSurface({ key: "google-chat/acme/AAAA", trust: "internal" })]);
ok(bindFrom(ctx(externalAuth)).trust === "external", "vouching the space does not promote an outside sender");
registerSurfaces([]);

registerGoogleChatPolicy({ enabled: true, audience: { kind: "project-number", projectNumber: "42" }, workspace: "acme", internalDomainIds: [], directMessages: true });
const posts: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.it", expires_in: 3600 }), { status: 200 });
  if (u.startsWith("https://chat.googleapis.com/")) {
    posts.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ name: "spaces/AAAA/messages/reply1", thread: { name: "spaces/AAAA/threads/t1" } }), { status: 200 });
  }
  throw new Error(`unexpected fetch in the integration test: ${u}`);
}) as typeof fetch;
try {
  const id = await postUnifiedReply(origin, "Launch is Thursday.");
  ok(id === "spaces/AAAA/messages/reply1", "postUnifiedReply returns the created message name");
  ok(posts.length === 1 && posts[0]!.url.startsWith("https://chat.googleapis.com/v1/spaces/AAAA/messages"), "the reply reaches the Chat API, into the origin's space");
  ok((posts[0]!.body["thread"] as { name: string }).name === "spaces/AAAA/threads/t1", "the reply threads under the origin's thread");
  ok(String(posts[0]!.body["text"]).includes("Launch is Thursday."), "the reply carries the seat's text");
} finally {
  globalThis.fetch = realFetch;
}

console.log(`✓ google-chat-provider-integration-test: ${passed} assertions`);
