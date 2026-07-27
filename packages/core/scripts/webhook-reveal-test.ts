import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const dir = join(tmpdir(), `oe-webhook-reveal-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.OE_INTAKE_PAGE_SIGNING_KEY = randomBytes(32).toString("base64");
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.test";

const SENTINEL = "FAKE-HOOK-SIGNING-SECRET-1a2b3c-DO-NOT-USE";

const reveal = await import("../agent/webhooks/reveal-page.js");
const intakePage = await import("../agent/credentials/intake-page.js");
const { mintPageToken, pageTokenSigningKey } = await import("../agent/credentials/page-token.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");

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
const KEY = pageTokenSigningKey()!;
const USER = "U-DECIDER";
const OTHER = "U-SOMEONE-ELSE";

const getReq = (token: string) => new Request(`https://oe.example.test${reveal.REVEAL_PAGE_PATH}?t=${encodeURIComponent(token)}`);
const postReq = (token: string) =>
  new Request(`https://oe.example.test${reveal.REVEAL_PAGE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ t: token }).toString(),
  });

function countingReader(value: string | null = SENTINEL) {
  const state = { calls: 0 };
  return { state, read: async () => ((state.calls += 1), value) };
}

async function freshGrant(opts: { to?: string } = {}): Promise<{ token: string; ref: string; id: string }> {
  const id = `hk_${randomBytes(8).toString("hex")}`;
  const ref = `hook:${id}`;
  await vault.write(ref, SENTINEL);
  const link = await reveal.issueRevealLink({ org: ORG, ref, revealTo: opts.to ?? USER, label: "notion" });
  assert.ok(link, "issueRevealLink returned a link");
  const token = new URL(link.url).searchParams.get("t")!;
  return { token, ref, id: link.id };
}

{
  console.log("\n1. audience (cross-route replay wall):");
  const { token } = await freshGrant();
  eq(intakePage.verifyIntakePageToken(token, KEY), null, "🔴 a reveal token does NOT verify at the intake route");
  const intakeToken = intakePage.mintIntakePageToken({ v: 1, org: ORG, id: "some-intake", rb: USER, exp: Date.now() + 60_000 }, KEY);
  const res = await reveal.handleRevealGet(getReq(intakeToken));
  eq(res.status, 404, "🔴 an intake token does NOT verify at the reveal route");
  const legacy = mintPageToken({ v: 1, aud: undefined as never, org: ORG, id: "x", rb: USER, exp: Date.now() + 60_000 }, KEY);
  eq(intakePage.verifyIntakePageToken(legacy, KEY), null, "an audience-less legacy token is refused at intake");
  eq((await reveal.handleRevealGet(getReq(legacy))).status, 404, "an audience-less legacy token is refused at reveal");
}

{
  console.log("\n2. GET is side-effect free (the unfurler case):");
  const { token, id } = await freshGrant();
  const reader = countingReader();

  for (let i = 0; i < 3; i++) {
    const res = await reveal.handleRevealGet(getReq(token), { readSecret: reader.read });
    eq(res.status, 200, `GET #${i + 1} renders the confirm page`);
    const html = await res.text();
    ok(!html.includes(SENTINEL), `GET #${i + 1} contains NO secret`);
    ok(html.includes("Show the secret"), `GET #${i + 1} renders the confirm button`);
    ok(html.includes(`name="t"`), `GET #${i + 1} carries the token in the form, so the POST can redeem it`);
  }
  eq(reader.state.calls, 0, "🔴 GET never reads the vault");
  eq((await store.getCredentialIntake(ORG, id))!.usedAt, undefined, "🔴 THREE GETs leave the grant UNCONSUMED — an unfurler cannot burn the reveal");

  const after = await reveal.handleRevealPost(postReq(token), { readSecret: reader.read });
  eq(after.status, 200, "the POST after three GETs still succeeds");
  ok((await after.text()).includes(SENTINEL), "…and reveals the secret");
}

{
  console.log("\n3. POST reveals once (+ placement and headers):");
  const { token, id } = await freshGrant();
  const reader = countingReader();

  const first = await reveal.handleRevealPost(postReq(token), { readSecret: reader.read });
  eq(first.status, 200, "first POST succeeds");
  const html = await first.text();

  eq(html.split(SENTINEL).length - 1, 1, "🔴 the secret appears EXACTLY ONCE in the HTML");
  ok(html.includes(`<code>${SENTINEL}</code>`), "…as a text node inside <code>");
  const attrValues = [...html.matchAll(/\w+="([^"]*)"/g)].map((m) => m[1]!);
  ok(!attrValues.some((v) => v.includes(SENTINEL)), "🔴 the secret is in NO attribute value");
  ok(!html.includes(`href=`) || !attrValues.some((v) => v.startsWith("http") && v.includes(SENTINEL)), "the secret is in no href");
  ok(!html.includes(`type="hidden"`), "the reveal page carries no hidden fields at all");
  ok(html.includes(`https://oe.example.test/webhooks/hk_`), "the endpoint URL is shown beside the secret");

  eq(first.headers.get("cache-control"), "no-store", "no-store");
  eq(first.headers.get("referrer-policy"), "no-referrer", "🔴 Referrer-Policy: no-referrer (a reveal page must not leak its own token)");
  ok(html.includes("noindex,nofollow"), "noindex,nofollow");

  eq(reader.state.calls, 1, "the vault was read exactly once");
  eq(typeof (await store.getCredentialIntake(ORG, id))!.usedAt, "string", "the grant is now consumed");

  const second = await reveal.handleRevealPost(postReq(token), { readSecret: reader.read });
  eq(second.status, 404, "🔴 the second POST is refused");
  ok(!(await second.text()).includes(SENTINEL), "…and carries no secret");
  eq(reader.state.calls, 1, "🔴 the burned grant NEVER reaches the vault again (consume-before-decrypt)");

  const afterGet = await reveal.handleRevealGet(getReq(token), { readSecret: reader.read });
  eq(afterGet.status, 404, "GET after redemption is the generic 404");
  eq(reader.state.calls, 1, "…and still no vault read");
}

{
  console.log("\n4. consume-before-decrypt:");
  const { token, id } = await freshGrant();
  const reader = countingReader();
  const [a, b] = await Promise.all([
    reveal.handleRevealPost(postReq(token), { readSecret: reader.read }),
    reveal.handleRevealPost(postReq(token), { readSecret: reader.read }),
  ]);
  const statuses = [a.status, b.status].sort();
  eq(statuses, [200, 404], "🔴 two concurrent redemptions resolve exactly one winner");
  eq(reader.state.calls, 1, "🔴 the loser never reaches the vault (the CAS runs first)");
  eq(typeof (await store.getCredentialIntake(ORG, id))!.usedAt, "string", "the grant is consumed");

  const broken = await freshGrant();
  const boom = await reveal.handleRevealPost(postReq(broken.token), {
    readSecret: async () => {
      throw new Error("vault exploded");
    },
  });
  eq(boom.status, 404, "a vault failure renders the generic 404 (never the reason)");
  eq(typeof (await store.getCredentialIntake(ORG, broken.id))!.usedAt, "string", "🔴 a failed reveal leaves the grant SPENT — recovery is rotation, not retry");
  eq((await reveal.handleRevealPost(postReq(broken.token), { readSecret: async () => SENTINEL })).status, 404, "…and a retry with a working vault is still refused");

  const empty = await freshGrant();
  eq((await reveal.handleRevealPost(postReq(empty.token), { readSecret: async () => null })).status, 404, "a vault miss ⇒ the generic 404");
}

{
  console.log("\n5. no oracle (every failure is byte-identical):");
  const { token } = await freshGrant();
  const canonical = await (await reveal.handleRevealGet(getReq("garbage"))).text();

  const cases: [string, string][] = [
    ["malformed token", "not-a-token"],
    ["empty token", ""],
    ["tampered signature", `${token.split(".")[0]}.${"A".repeat((token.split(".")[1] ?? "").length)}`],
    ["tampered payload", `${Buffer.from(JSON.stringify({ v: 1, aud: "reveal", org: ORG, id: "other", rb: USER, exp: Date.now() + 60_000 })).toString("base64url")}.${token.split(".")[1]}`],
    ["expired", mintPageToken({ v: 1, aud: "reveal", org: ORG, id: "x", rb: USER, exp: Date.now() - 1 }, KEY)],
    ["unknown row", mintPageToken({ v: 1, aud: "reveal", org: ORG, id: "no-such-row", rb: USER, exp: Date.now() + 60_000 }, KEY)],
    ["wrong org", mintPageToken({ v: 1, aud: "reveal", org: "other-org", id: "x", rb: USER, exp: Date.now() + 60_000 }, KEY)],
  ];
  for (const [label, t] of cases) {
    const g = await reveal.handleRevealGet(getReq(t));
    eq(g.status, 404, `GET ${label} ⇒ 404`);
    eq(await g.text(), canonical, `GET ${label} ⇒ byte-identical page (no oracle)`);
    const p = await reveal.handleRevealPost(postReq(t));
    eq(p.status, 404, `POST ${label} ⇒ 404`);
  }

  const bound = await freshGrant({ to: USER });
  const impostor = mintPageToken({ v: 1, aud: "reveal", org: ORG, id: bound.id, rb: OTHER, exp: Date.now() + 60_000 }, KEY);
  const impRes = await reveal.handleRevealGet(getReq(impostor));
  eq(impRes.status, 404, "🔴 a validly-signed token naming a DIFFERENT principal is refused");
  eq(await impRes.text(), canonical, "…with the same generic page");
  eq((await store.getCredentialIntake(ORG, bound.id))!.usedAt, undefined, "…and the real grant is untouched");

  await store.addCredentialIntake({
    org: ORG,
    id: "intake-row",
    ref: "db:notion-key",
    provider: "notion",
    requestedBy: USER,
    channelId: "C1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const wrongKind = mintPageToken({ v: 1, aud: "reveal", org: ORG, id: "intake-row", rb: USER, exp: Date.now() + 60_000 }, KEY);
  eq((await reveal.handleRevealPost(postReq(wrongKind), { readSecret: async () => SENTINEL })).status, 404, "🔴 a reveal token cannot redeem an api-key INTAKE row");
  eq((await store.getCredentialIntake(ORG, "intake-row"))!.usedAt, undefined, "…and the intake row is not consumed by the attempt");
}

{
  console.log("\n6. disarmed deployment:");
  const { token } = await freshGrant();
  ok(reveal.revealPageAvailable(), "armed: signing key + base url present");
  const saved = process.env.OE_INTAKE_PAGE_SIGNING_KEY;
  delete process.env.OE_INTAKE_PAGE_SIGNING_KEY;
  ok(!reveal.revealPageAvailable(), "no signing key ⇒ not available (create_webhook refuses at propose time)");
  eq((await reveal.handleRevealGet(getReq(token))).status, 404, "no signing key ⇒ GET 404 (route effectively absent)");
  eq((await reveal.handleRevealPost(postReq(token))).status, 404, "no signing key ⇒ POST 404");
  eq(await reveal.issueRevealLink({ org: ORG, ref: "hook:x", revealTo: USER, label: "x" }), undefined, "…and no link can be minted");
  process.env.OE_INTAKE_PAGE_SIGNING_KEY = saved;

  const savedBase = process.env.OE_PUBLIC_BASE_URL;
  delete process.env.OE_PUBLIC_BASE_URL;
  ok(!reveal.revealPageAvailable(), "no base url ⇒ not available (no dead links are ever handed out)");
  process.env.OE_PUBLIC_BASE_URL = savedBase;

  eq(reveal.revealEndpointUrl("hook:hk_abc"), "https://oe.example.test/webhooks/hk_abc", "a current ref resolves to the ingress url");
  eq(reveal.revealEndpointUrl("hook:hk_abc:prev"), undefined, "a SUPERSEDED ref resolves to nothing (a reveal only ever discloses the current key)");
  eq(reveal.revealEndpointUrl("db:notion-key"), undefined, "a non-hook ref resolves to nothing");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n✅ webhook-reveal: ${n} checks passed`);
