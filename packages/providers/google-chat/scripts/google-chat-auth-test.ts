import { exportPKCS8, generateKeyPair, SignJWT, decodeJwt, type JWTVerifyGetKey, } from "jose";
import {
  CHAT_ISSUER_ACCOUNT,
  googleChatAccessToken,
  parseServiceAccountKey,
  resetGoogleChatTokenCache,
  verifyGoogleChatToken,
} from "../agent/channels/google-chat-auth.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejects(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const google = await generateKeyPair("RS256", { extractable: true });
const stranger = await generateKeyPair("RS256");
const keys: JWTVerifyGetKey = async () => google.publicKey as CryptoKey;

async function token(claims: Record<string, unknown>, opts: { iss: string; aud: string; key?: CryptoKey; exp?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setIssuedAt(now - 10)
    .setExpirationTime(opts.exp ?? now + 300)
    .sign(opts.key ?? (google.privateKey as CryptoKey));
}

const PN = { kind: "project-number" as const, projectNumber: "123456789" };
const dPn = { chatSystemKeys: keys };
const good = await token({}, { iss: CHAT_ISSUER_ACCOUNT, aud: "123456789" });
ok((await verifyGoogleChatToken(`Bearer ${good}`, PN, dPn)).ok, "a Chat-signed token for the project number verifies");
ok(!(await verifyGoogleChatToken(`Bearer ${await token({}, { iss: CHAT_ISSUER_ACCOUNT, aud: "999" })}`, PN, dPn)).ok, "another project's audience is refused");
ok(!(await verifyGoogleChatToken(`Bearer ${await token({}, { iss: "someone@else.iam.gserviceaccount.com", aud: "123456789" })}`, PN, dPn)).ok, "another issuer is refused");
ok(!(await verifyGoogleChatToken(`Bearer ${await token({}, { iss: CHAT_ISSUER_ACCOUNT, aud: "123456789", key: stranger.privateKey as CryptoKey })}`, PN, dPn)).ok, "a token signed by another key is refused");
const expired = await token({}, { iss: CHAT_ISSUER_ACCOUNT, aud: "123456789", exp: Math.floor(Date.now() / 1000) - 120 });
ok(!(await verifyGoogleChatToken(`Bearer ${expired}`, PN, dPn)).ok, "an expired token is refused");
ok(!(await verifyGoogleChatToken(undefined, PN, dPn)).ok, "no Authorization header is refused");
ok(!(await verifyGoogleChatToken(good, PN, dPn)).ok, "a token without the Bearer scheme is refused");
ok(!(await verifyGoogleChatToken(`Bearer ${good}`, null, dPn)).ok, "a null audience refuses even a good token");
const refused = await verifyGoogleChatToken(`Bearer ${await token({}, { iss: CHAT_ISSUER_ACCOUNT, aud: "999" })}`, PN, dPn);
ok(!refused.ok && !refused.reason.includes("999") && !refused.reason.includes("eyJ"), "a refusal names the check, never a claim value or the token");

const URL_AUD = { kind: "endpoint-url" as const, url: "https://agent.acme.com/eve/v1/google-chat" };
const dUrl = { googleOidcKeys: keys };
const chatOidc = await token({ email: CHAT_ISSUER_ACCOUNT, email_verified: true }, { iss: "https://accounts.google.com", aud: URL_AUD.url });
ok((await verifyGoogleChatToken(`Bearer ${chatOidc}`, URL_AUD, dUrl)).ok, "Google Chat's id token for the endpoint URL verifies");
const otherAccount = await token({ email: "attacker@gmail.com", email_verified: true }, { iss: "https://accounts.google.com", aud: URL_AUD.url });
ok(!(await verifyGoogleChatToken(`Bearer ${otherAccount}`, URL_AUD, dUrl)).ok, "an id token another Google account minted for the same URL is refused");
const unverified = await token({ email: CHAT_ISSUER_ACCOUNT, email_verified: false }, { iss: "https://accounts.google.com", aud: URL_AUD.url });
ok(!(await verifyGoogleChatToken(`Bearer ${unverified}`, URL_AUD, dUrl)).ok, "an unverified email claim is refused");
const otherUrl = await token({ email: CHAT_ISSUER_ACCOUNT, email_verified: true }, { iss: "https://accounts.google.com", aud: "https://evil.example/eve/v1/google-chat" });
ok(!(await verifyGoogleChatToken(`Bearer ${otherUrl}`, URL_AUD, dUrl)).ok, "an id token for another URL is refused");

const pkcs8 = await exportPKCS8(google.privateKey as CryptoKey);
const KEY = JSON.stringify({ type: "service_account", client_email: "oe-bot@proj.iam.gserviceaccount.com", private_key: pkcs8, token_uri: "https://evil.example/token" });
const calls: { url: string; body: string }[] = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), body: String(init?.body ?? "") });
  return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
}) as typeof fetch;
resetGoogleChatTokenCache();
const t1 = await googleChatAccessToken({ fetch: fakeFetch, serviceAccountKey: async () => KEY });
ok(t1 === "ya29.test", "the grant returns the endpoint's access token");
ok(calls.length === 1 && calls[0]!.url === "https://oauth2.googleapis.com/token", "the grant posts to the pinned token endpoint, never the key's own token_uri");
const form = new URLSearchParams(calls[0]!.body);
ok(form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer", "the grant is a JWT-bearer grant");
const claims = decodeJwt(form.get("assertion") ?? "");
ok(claims.iss === "oe-bot@proj.iam.gserviceaccount.com" && claims["scope"] === "https://www.googleapis.com/auth/chat.bot", "the assertion is the service account's, for the chat.bot scope only");
ok(claims.aud === "https://oauth2.googleapis.com/token", "the assertion's audience is the pinned token endpoint");
await googleChatAccessToken({ fetch: fakeFetch, serviceAccountKey: async () => KEY });
ok(calls.length === 1, "a second call inside the token's lifetime reuses the cached token");
await googleChatAccessToken({ fetch: fakeFetch, serviceAccountKey: async () => KEY, now: () => Date.now() + 3600_000 });
ok(calls.length === 2, "a call past the token's lifetime mints a new one");

resetGoogleChatTokenCache();
await rejects(() => googleChatAccessToken({ fetch: fakeFetch, serviceAccountKey: async () => "{not json" }), "is not JSON", "a non-JSON key refuses");
await rejects(
  () => googleChatAccessToken({ fetch: fakeFetch, serviceAccountKey: async () => JSON.stringify({ type: "authorized_user", client_email: "x", private_key: "y" }) }),
  "not a Google service-account key",
  "a key of another type refuses",
);
const denied = (async () => new Response("{}", { status: 400 })) as typeof fetch;
try {
  await googleChatAccessToken({ fetch: denied, serviceAccountKey: async () => KEY });
  ok(false, "a refused grant throws");
} catch (err) {
  ok(String(err).includes("HTTP 400") && !String(err).includes("PRIVATE KEY"), "a refused grant names the status, never the key");
}
ok(parseServiceAccountKey(KEY).clientEmail === "oe-bot@proj.iam.gserviceaccount.com", "the key parser reads the client email");

console.log(`✓ google-chat-auth-test: ${passed} assertions`);
