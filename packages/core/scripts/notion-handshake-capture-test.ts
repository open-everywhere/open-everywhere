import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-handshake-capture-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.OE_INTAKE_PAGE_SIGNING_KEY = randomBytes(32).toString("base64");
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.test";

const TOKEN = "secret_FAKE-NOTION-VERIFICATION-TOKEN-0123456789abcdefghijklmnop-DO-NOT-USE";

const capture = await import("../agent/webhooks/handshake-capture.js");
const reveal = await import("../agent/webhooks/reveal-page.js");
const { NOTION_HANDSHAKE_REF_NAMESPACE, reservedRefNamespace } = await import("../agent/credentials/reserved-refs.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { verifyPageToken, pageTokenSigningKey } = await import("../agent/credentials/page-token.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const store = getOperationalStore();
const vault = encryptedKvVault();

async function captured<T>(fn: (log: (m: string) => void) => Promise<T>): Promise<{ result: T; lines: string[]; text: string }> {
  const lines: string[] = [];
  const result = await fn((m) => lines.push(m));
  return { result, lines, text: lines.join("\n") };
}

const run = (deps: Parameters<typeof capture.captureHandshakeSecret>[1], value = TOKEN, ns = NOTION_HANDSHAKE_REF_NAMESPACE) =>
  captured((log) => capture.captureHandshakeSecret({ refNamespace: ns, label: "Notion webhook (verification_token)", value }, { ...deps, log }));

const linkToken = (text: string): string => new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get("t")!;

const revealPost = (token: string) =>
  new Request(`https://oe.example.test${reveal.REVEAL_PAGE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: token }).toString(),
  });

const armed = await run({});
{
  console.log("\n1. the armed handshake log does not contain the token:");
  ok(!armed.text.includes(TOKEN), "🔴 the token value appears NOWHERE in the captured log output");
  ok(!armed.text.includes(TOKEN.slice(0, 16)), "no 16-char prefix of the token is logged (a truncated leak is still a leak)");
  ok(!armed.text.includes(TOKEN.slice(-16)), "no 16-char suffix of the token is logged");
  eq(armed.lines.length, 1, "exactly one operator-facing line is logged");
  ok(armed.result.revealed && armed.result.stored, "armed path both stores and reveals");
  ok(armed.text.includes(armed.result.fingerprint), "the line carries the fingerprint");
  ok(/https:\/\/oe\.example\.test\/connect\/v1\/reveal\?t=/.test(armed.text), "the line carries the one-shot reveal link instead of the value");
  ok(/single-use/i.test(armed.text) && /minutes/i.test(armed.text), "the line states the bounds that actually apply (single-use + a time window)");
}

{
  console.log("\n2. fingerprint:");
  const fp = armed.result.fingerprint;
  eq(fp.length, 8, "the fingerprint is 8 characters");
  ok(/^[0-9a-f]{8}$/.test(fp), "…and is lowercase hex");
  eq(fp, createHash("sha256").update(TOKEN, "utf8").digest("hex").slice(0, 8), "…and equals the sha256 prefix an operator can recompute with sha256sum");
  ok(!TOKEN.startsWith(fp), "🔴 the fingerprint is NOT a prefix of the token");
  ok(!TOKEN.includes(fp), "…and does not appear anywhere inside the token");
  ok(capture.secretFingerprint(TOKEN) !== capture.secretFingerprint(TOKEN + "x"), "a different value fingerprints differently");
}

{
  console.log("\n3. stored + revealable through the real reveal handlers:");
  const ref = armed.result.ref!;
  eq(await vault.read(ref), TOKEN, "the value round-trips out of the encrypted vault under the returned ref");

  const token = linkToken(armed.text);
  const first = await reveal.handleRevealPost(revealPost(token));
  const firstHtml = await first.text();
  eq(first.status, 200, "the logged link redeems");
  ok(firstHtml.includes(TOKEN), "…and the reveal page shows the captured token");
  ok(!firstHtml.includes("/webhooks/"), "🔴 no bogus ingress URL is rendered beside the secret (the ref is not in the `hook:` grammar)");
  ok(!firstHtml.includes("Point the sender at this URL"), "…the endpoint block is absent entirely");

  const second = await reveal.handleRevealPost(revealPost(token));
  eq(second.status, 404, "the link is single-use — a second redemption is refused");
  ok(!(await second.text()).includes(TOKEN), "…and discloses nothing");
}

{
  console.log("\n4. ref namespace:");
  const ref = armed.result.ref!;
  ok(ref.startsWith(NOTION_HANDSHAKE_REF_NAMESPACE), `the ref is minted under ${NOTION_HANDSHAKE_REF_NAMESPACE}`);
  ok(!ref.startsWith("hook:"), "🔴 and deliberately NOT under `hook:` — see revealEndpointUrl");
  eq(reservedRefNamespace(ref), NOTION_HANDSHAKE_REF_NAMESPACE, "the ref sits in a RESERVED namespace (the egress broker refuses it — pinned in webhook-runtime-test)");
  eq(reveal.revealEndpointUrl(ref), undefined, "revealEndpointUrl renders nothing for this ref");
}

{
  console.log("\n5. reveal page unavailable:");
  const dis = await run({ available: () => false });
  ok(!dis.text.includes(TOKEN), "🔴 the token is NOT logged when the reveal page is unavailable");
  ok(!dis.text.includes(TOKEN.slice(0, 16)), "…not even truncated");
  ok(dis.result.stored && !dis.result.revealed, "the value is still captured; nothing is revealed");
  eq(await vault.read(dis.result.ref!), TOKEN, "…and it really is in the vault, retrievable once the page is armed");
  ok(/OE_CREDENTIAL_ENCRYPTION_KEY/.test(dis.text) && /OE_PUBLIC_BASE_URL/.test(dis.text), "the log names the two things that arm the page (the vault key + the base URL — OPE-408 step 3, the signing key itself is no longer operator-set)");
  ok(/recreate the subscription/i.test(dis.text), "…and tells the operator how to get a fresh handshake");

  const raced = await run({ issueLink: async () => undefined });
  ok(!raced.text.includes(TOKEN), "a failed grant mint does not fall back to logging the value");
  ok(raced.result.stored && !raced.result.revealed, "…and still stores it");
}

{
  console.log("\n6. refusals:");
  const unreserved = await run({}, TOKEN, "notion-handshake-");
  ok(!unreserved.text.includes(TOKEN), "an unreserved namespace refuses WITHOUT logging the value");
  ok(!unreserved.result.stored && unreserved.result.ref === undefined, "…and stores nothing (a signing key must never sit in an egress-resolvable ref)");
  ok(/not reserved/i.test(unreserved.text), "…and says why");

  const hookNs = await run({}, TOKEN, "hook:");
  ok(hookNs.result.stored, "`hook:` passes the RESERVED guard (the reason to avoid it is revealEndpointUrl, not this check)");
  ok(reveal.revealEndpointUrl(hookNs.result.ref!) !== undefined, "🔴 …and proves it: a hook:-namespaced handshake ref DOES render an endpoint URL");

  const empty = await run({}, "");
  ok(!empty.result.stored, "an empty value refuses rather than storing a non-secret as a key");
  ok(/no readable secret/i.test(empty.text), "…and says so");
}

{
  console.log("\n7. bearer-only grant:");
  eq(capture.HANDSHAKE_REVEAL_PRINCIPAL, "operator:deploy-log", "the bound principal is the documented sentinel");
  const fresh = await run({});
  const freshToken = linkToken(fresh.text);
  const claims = verifyPageToken(freshToken, pageTokenSigningKey()!, "reveal", Date.now())!;
  eq(claims.rb, capture.HANDSHAKE_REVEAL_PRINCIPAL, "the TOKEN binds to the sentinel");

  const row = await store.getCredentialIntake(ORG, claims.id);
  ok(row !== null, "the grant row exists");
  eq(row!.requestedBy, capture.HANDSHAKE_REVEAL_PRINCIPAL, "🔴 requestedBy is the SENTINEL — there is no clicker, so this is NOT identity binding");
  eq(row!.provider, reveal.REVEAL_GRANT_PROVIDER, "the row is a REVEAL grant (an intake token can never redeem it)");
  ok(!row!.usedAt, "unredeemed");
  eq(Date.parse(row!.expiresAt) - Date.parse(row!.createdAt), reveal.REVEAL_GRANT_TTL_MS, "bound #1: a 15-minute TTL");
  eq((await reveal.handleRevealPost(revealPost(freshToken))).status, 200, "bound #2: single-use — the first redemption works…");
  eq((await reveal.handleRevealPost(revealPost(freshToken))).status, 404, "…and the second does not, from ANY holder (there is no third bound)");
}

console.log(`\n✓ notion handshake capture — ${n} assertions passed`);
rmSync(dir, { recursive: true, force: true });
