import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const dir = join(tmpdir(), `oe-webhook-reveal-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
const ORG = "default";
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.OE_INTAKE_PAGE_SIGNING_KEY = randomBytes(32).toString("base64");
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.test";

const SENTINEL = "FAKE-HOOK-SIGNING-SECRET-1a2b3c-DO-NOT-USE";

const reveal = await import("../agent/webhooks/reveal-page.js");
const intakePage = await import("../agent/credentials/intake-page.js");
const { readAudit } = await import("../agent/audit/audit.js");
type WebhookHook = import("../agent/webhooks/config.js").WebhookHook;
const DECLARED: WebhookHook[] = [];
const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadWebhooks: () => DECLARED,
} as never);
const { PAGE_AUDIENCES, mintPageToken, verifyPageToken, pageTokenSigningKey } = await import("../agent/credentials/page-token.js");
const { completeCredentialIntake, createCredentialIntake, handleSetKeyClick } = await import("../agent/credentials/intake.js");
type PageAudience = import("../agent/credentials/page-token.js").PageAudience;
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
const { resetSelfSecretCache } = await import("../agent/credentials/self-secrets.js");
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
    connector: "notion",
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
  console.log("\n6. disarmed deployment, and the signing key's new mint-on-first-use home:");
  const { token: tokenBeforeMint } = await freshGrant();
  ok(reveal.revealPageAvailable(), "armed: vault + base url present");

  const saved = process.env.OE_INTAKE_PAGE_SIGNING_KEY;
  delete process.env.OE_INTAKE_PAGE_SIGNING_KEY;
  resetSelfSecretCache();
  ok(reveal.revealPageAvailable(), "no signing key env var ⇒ STILL available (mints on first use, OPE-408 step 3)");
  const { token: mintedToken } = await freshGrant();
  eq((await reveal.handleRevealGet(getReq(mintedToken))).status, 200, "no signing key env var ⇒ GET still 200 (resolves via mint)");
  const mintedLink = await reveal.issueRevealLink({ org: ORG, ref: "hook:mint-check", revealTo: USER, label: "mint-check" });
  ok(mintedLink !== undefined, "…and a link CAN still be minted");
  const mintedValue = await vault.read("self:OE_INTAKE_PAGE_SIGNING_KEY");
  ok(typeof mintedValue === "string" && mintedValue.length > 0, "the minted signing key is durably stored under self:OE_INTAKE_PAGE_SIGNING_KEY");
  process.env.OE_INTAKE_PAGE_SIGNING_KEY = saved;
  await vault.delete("self:OE_INTAKE_PAGE_SIGNING_KEY");
  resetSelfSecretCache();

  const savedKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  ok(!reveal.revealPageAvailable(), "no encryption key ⇒ not available (nothing can be read or minted)");
  eq((await reveal.handleRevealGet(getReq(tokenBeforeMint))).status, 404, "no encryption key ⇒ GET 404 (route effectively absent)");
  eq((await reveal.handleRevealPost(postReq(tokenBeforeMint))).status, 404, "no encryption key ⇒ POST 404");
  eq(await reveal.issueRevealLink({ org: ORG, ref: "hook:x", revealTo: USER, label: "x" }), undefined, "…and no link can be minted");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = savedKey;

  const savedBase = process.env.OE_PUBLIC_BASE_URL;
  delete process.env.OE_PUBLIC_BASE_URL;
  ok(!reveal.revealPageAvailable(), "no base url ⇒ not available (no dead links are ever handed out)");
  process.env.OE_PUBLIC_BASE_URL = savedBase;

  eq(reveal.revealEndpointUrl("hook:hk_abc"), "https://oe.example.test/webhooks/hk_abc", "a current ref resolves to the ingress url");
  eq(reveal.revealEndpointUrl("hook:hk_abc:prev"), undefined, "a SUPERSEDED ref resolves to nothing (a reveal only ever discloses the current key)");
  eq(reveal.revealEndpointUrl("db:notion-key"), undefined, "a non-hook ref resolves to nothing");
  eq(reveal.revealEndpointUrl("db:webhook:deploy-status"), "https://oe.example.test/webhooks/deploy-status", "a config hook's db ref resolves to its ingress url");
  eq(reveal.revealEndpointUrl("db:webhook:deploy:status"), undefined, "…and a ref with a second colon is refused rather than truncated into some other hook's URL");
  eq(reveal.revealEndpointUrl("db:webhook:"), undefined, "…as is an empty id");
}

{
  console.log("\n8. sender guidance (success path only, per scheme):");
  const swMod = await import("../agent/webhooks/oe-standard-webhook.js");
  const { registerWebhookVerifier } = await import("../agent/webhooks/verifier.js");

  const OTHER_SCHEME = "reveal-guidance-fixture";
  const OTHER_HEADERS = [
    { name: "x-fixture-timestamp", value: "<unix seconds>" },
    { name: "x-fixture-signature", value: "<hex>" },
  ] as const;
  registerWebhookVerifier({
    source: OTHER_SCHEME,
    keyKind: "shared-secret",
    keyOrigin: "receiver-minted",
    signedTimestamp: false,
    verify: () => ({ ok: false, failure: "missing-signature" }),
    senderGuidance: () => ({
      headers: OTHER_HEADERS.map((h) => ({ ...h })),
      signedContent: "fixture:<the raw request body, byte for byte>",
      notes: ["A fixture scheme, registered by this test only."],
    }),
  });

  let hookSeq = 0;
  async function grantForHook(scheme: string | undefined, opts: { org?: string } = {}): Promise<string> {
    const id = `my-ci-${++hookSeq}`;
    const ref = `db:webhook:${id}`;
    await vault.write(ref, SENTINEL);
    DECLARED.push({
      id,
      source: scheme ?? "unregistered-scheme",
      secretRef: ref,
      broker: "db",
      posture: "trigger-only",
      readableBy: [{ level: "domain", domain: "eng" }],
    });
    const link = await reveal.issueRevealLink({ org: opts.org ?? ORG, ref, revealTo: USER, label: id });
    return new URL(link!.url).searchParams.get("t")!;
  }

  const swGuide = swMod.standardWebhookSenderGuidance();
  const swHtml = await (await reveal.handleRevealPost(postReq(await grantForHook(swMod.OE_STANDARD_WEBHOOK_SCHEME)), { readSecret: async () => SENTINEL })).text();
  for (const h of swGuide.headers) ok(swHtml.includes(`<code>${h.name}</code>`), `the page names the "${h.name}" header the sender must set`);
  ok(swHtml.includes(swGuide.signedContent.replace(/</g, "&lt;").replace(/>/g, "&gt;")), "🔴 …and shows the exact basestring the signature covers, escaped");
  ok(swGuide.notes.every((t) => swHtml.includes(t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"))), "…and every note, escaped");
  eq(swHtml.split(SENTINEL).length - 1, 1, "🔴 the secret STILL appears exactly once with the guidance rendered");
  ok(![...swHtml.matchAll(/\w+="([^"]*)"/g)].map((m) => m[1]!).some((v) => v.includes(SENTINEL)), "🔴 …and still in NO attribute value");
  ok(!swHtml.includes(`type="hidden"`), "…and the page still carries no hidden fields");

  const otherHtml = await (await reveal.handleRevealPost(postReq(await grantForHook(OTHER_SCHEME)), { readSecret: async () => SENTINEL })).text();
  for (const h of OTHER_HEADERS) ok(otherHtml.includes(`<code>${h.name}</code>`), `a "${OTHER_SCHEME}" hook's page names "${h.name}" instead`);
  for (const h of swGuide.headers) ok(!otherHtml.includes(`<code>${h.name}</code>`), `🔴 …and NOT the (b) contract's "${h.name}"`);
  for (const h of OTHER_HEADERS) ok(!swHtml.includes(`<code>${h.name}</code>`), `🔴 …and the (b) page does not carry the other scheme's "${h.name}"`);
  ok(!swGuide.headers.some((a) => OTHER_HEADERS.some((b) => a.name === b.name)), "the two schemes under test share NOT ONE header name (the exclusions above are not vacuous)");

  const unknownRes = await reveal.handleRevealPost(postReq(await grantForHook("no-such-scheme")), { readSecret: async () => SENTINEL });
  eq(unknownRes.status, 200, "a scheme with no registered guidance still reveals");
  const unknownHtml = await unknownRes.text();
  ok(unknownHtml.includes(SENTINEL) && !unknownHtml.includes("must send these headers"), "…with the secret and no instruction block at all");

  const orphanRes = await reveal.handleRevealPost(postReq((await freshGrant()).token), { readSecret: async () => SENTINEL });
  eq(orphanRes.status, 200, "a grant whose hook row no longer exists still reveals");
  ok((await orphanRes.text()).includes(SENTINEL), "…with the secret");

  const boomRes = await reveal.handleRevealPost(postReq(await grantForHook(swMod.OE_STANDARD_WEBHOOK_SCHEME)), {
    readSecret: async () => SENTINEL,
    senderGuidance: async () => {
      throw new Error("store exploded");
    },
  });
  eq(boomRes.status, 200, "🔴 a guidance lookup that THROWS still reveals — it costs the instructions, never the disclosure");
  ok((await boomRes.text()).includes(SENTINEL), "…and the secret is still shown");

  const crossHtml = await (await reveal.handleRevealPost(postReq(await grantForHook(swMod.OE_STANDARD_WEBHOOK_SCHEME, { org: ORG })), { readSecret: async () => SENTINEL })).text();
  ok(crossHtml.includes(`<code>${swMod.SW_ID_HEADER}</code>`), "a same-org hook resolves its guidance (the org check is not vacuously refusing everything)");

  const guidedToken = await grantForHook(swMod.OE_STANDARD_WEBHOOK_SCHEME);
  const confirmHtml = await (await reveal.handleRevealGet(getReq(guidedToken))).text();
  for (const h of swGuide.headers) ok(!confirmHtml.includes(`<code>${h.name}</code>`), `🔴 the GET confirm page leaks no guidance ("${h.name}")`);
  await reveal.handleRevealPost(postReq(guidedToken), { readSecret: async () => SENTINEL });
  const burnedHtml = await (await reveal.handleRevealPost(postReq(guidedToken), { readSecret: async () => SENTINEL })).text();
  eq(burnedHtml, await (await reveal.handleRevealGet(getReq("garbage"))).text(), "🔴 a burned grant's 404 is STILL byte-identical to every other failure — the guidance changed no failure page");
}

{
  console.log("\n9. the N×N cross-audience replay matrix:");

  interface MatrixCase {
    readonly mint: () => Promise<{ token: string; id: string }>;
    readonly get: (token: string) => Promise<Response>;
    readonly post: (token: string) => Promise<Response>;
  }

  const formPost = (path: string, handler: (r: Request) => Promise<Response>) => (token: string) =>
    handler(
      new Request(`https://oe.example.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: token, k: "FAKE-MATRIX-VALUE" }).toString(),
      }),
    );

  let seq = 0;
  const table: Record<PageAudience, MatrixCase> = {
    intake: {
      mint: async () => {
        const id = `matrix-intake-${seq++}`;
        await store.addCredentialIntake({ org: ORG, id, ref: "db:matrix-key", connector: "notion", requestedBy: USER, channelId: "C1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
        return { token: mintPageToken({ v: 1, aud: "intake", org: ORG, id, rb: USER, exp: Date.now() + 60_000 }, KEY), id };
      },
      get: (t) => intakePage.handleIntakePageGet(new Request(`https://oe.example.test${intakePage.INTAKE_PAGE_PATH}?t=${encodeURIComponent(t)}`)),
      post: formPost(intakePage.INTAKE_PAGE_PATH, (r) => intakePage.handleIntakePagePost(r)),
    },
    reveal: {
      mint: async () => {
        const g = await freshGrant();
        return { token: g.token, id: g.id };
      },
      get: (t) => reveal.handleRevealGet(getReq(t)),
      post: formPost(reveal.REVEAL_PAGE_PATH, (r) => reveal.handleRevealPost(r)),
    },
  };

  eq(Object.keys(table).length, PAGE_AUDIENCES.length, "the matrix table covers EVERY audience (a third one is a compile error until it is added here)");

  for (const mintedFor of PAGE_AUDIENCES) {
    for (const redeemedAt of PAGE_AUDIENCES) {
      const grant = await table[mintedFor].mint();
      const route = table[redeemedAt];
      const getRes = await route.get(grant.token);
      const postRes = await route.post(grant.token);
      if (mintedFor === redeemedAt) {
        eq(getRes.status, 200, `✔ ${mintedFor} → ${redeemedAt}: the matching route ACCEPTS (otherwise this matrix would pass vacuously)`);
        eq(postRes.status, 200, `✔ ${mintedFor} → ${redeemedAt}: …and redeems`);
      } else {
        eq(getRes.status, 404, `🔴 ${mintedFor} token at the ${redeemedAt} GET ⇒ refused`);
        eq(postRes.status, 404, `🔴 ${mintedFor} token at the ${redeemedAt} POST ⇒ refused`);
        eq((await store.getCredentialIntake(ORG, grant.id))!.usedAt, undefined, `…and the ${mintedFor} grant is untouched by the attempt`);
      }
    }
  }
}

{
  console.log("\n10. webhook.secret_revealed (OPE-199):");
  const id = "audited-hook";
  const ref = `db:webhook:${id}`;
  await vault.write(ref, SENTINEL);
  const link = (await reveal.issueRevealLink({ org: ORG, ref, revealTo: USER, label: "audited" }))!;
  const token = new URL(link.url).searchParams.get("t")!;

  await reveal.handleRevealGet(getReq(token));
  eq((await readAudit({ org: ORG, action: "webhook.secret_revealed" })).filter((r) => (r.detail as Record<string, unknown>).hookId === id).length, 0, "🔴 a GET writes NO disclosure row — nothing was disclosed");

  eq((await reveal.handleRevealPost(postReq(token))).status, 200, "the POST reveals");
  const rows = (await readAudit({ org: ORG, action: "webhook.secret_revealed" })).filter((r) => (r.detail as Record<string, unknown>).hookId === id);
  eq(rows.length, 1, "🔴 exactly one webhook.secret_revealed row");
  const d = rows[0]!.detail as Record<string, unknown>;
  eq(d.grantId, link.id, "…naming the grant that was burned");
  ok(typeof d.revealedAt === "string", "…and when");
  ok(!JSON.stringify(rows[0]).includes(SENTINEL), "🔴🔴 the row does NOT contain the secret");
  eq(rows[0]!.principalId, USER, "attributed to the bound principal");

  eq((await reveal.handleRevealPost(postReq(token))).status, 404, "the second POST is refused…");
  eq((await readAudit({ org: ORG, action: "webhook.secret_revealed" })).filter((r) => (r.detail as Record<string, unknown>).hookId === id).length, 1, "…and writes no second row");

  const deadLink = (await reveal.issueRevealLink({ org: ORG, ref: "db:webhook:dead-hook", revealTo: USER, label: "dead" }))!;
  const deadToken = new URL(deadLink.url).searchParams.get("t")!;
  const boom = await reveal.handleRevealPost(postReq(deadToken), {
    readSecret: async () => {
      throw new Error("vault exploded");
    },
  });
  eq(boom.status, 404, "a vault failure renders the generic 404");
  eq((await readAudit({ org: ORG, action: "webhook.secret_revealed" })).filter((r) => (r.detail as Record<string, unknown>).grantId === deadLink.id).length, 0, "🔴 …and writes NO disclosure row, because nothing was shown to anybody");
  ok(typeof (await store.getCredentialIntake(ORG, deadLink.id))!.usedAt === "string", "…while the grant is still SPENT (recovery is rotation, not retry)");

  eq(reveal.revealedHookId("hook:hk_abc"), "hk_abc", "a current hook ref yields its id");
  eq(reveal.revealedHookId("hook:hk_abc:prev"), undefined, "a SUPERSEDED ref yields none (it is not a current hook)");
  eq(reveal.revealedHookId("notion-handshake:ws1"), undefined, "a handshake ref names no runtime hook at all");
  eq(reveal.revealedHookId("db:webhook:deploy-status"), "deploy-status", "a config hook's db ref yields its declared id (OPE-224) — public by construction, since it is the path segment of a URL in a merged diff");
  eq(reveal.revealedHookId("db:notion:key"), undefined, "…and an ordinary stored-credential ref under some other connector names no hook");
}

{
  console.log("\n11. the cross-CLASS redemption wall (OPE-607):");

  const grant = await freshGrant();
  const grantRow = (await store.getCredentialIntake(ORG, grant.id))!;
  eq(grantRow.connector, reveal.REVEAL_GRANT_CONNECTOR, "fixture: the row really is a REVEAL grant, not an intake");
  eq(await vault.read(grantRow.ref), SENTINEL, "fixture: its ref holds the hook's live signing secret");

  const crossToken = mintPageToken({ v: 1, aud: "intake", org: ORG, id: grant.id, rb: USER, exp: Date.now() + 60_000 }, KEY);
  ok(verifyPageToken(crossToken, KEY, "intake", Date.now()) !== null, "🔴 the token CLEARS the first wall — it is a valid intake token, so nothing below is the audience check");

  const crossGet = await intakePage.handleIntakePageGet(
    new Request(`https://oe.example.test${intakePage.INTAKE_PAGE_PATH}?t=${encodeURIComponent(crossToken)}`),
  );
  eq(crossGet.status, 404, "🔴 the intake GET refuses a REVEAL-class row — no form renders for a grant");

  const ATTACKER_VALUE = "FAKE-ATTACKER-CHOSEN-KEY-DO-NOT-USE";
  const crossPost = await intakePage.handleIntakePagePost(
    new Request(`https://oe.example.test${intakePage.INTAKE_PAGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: crossToken, k: ATTACKER_VALUE }).toString(),
    }),
  );
  eq(crossPost.status, 404, "🔴 the intake POST refuses it too");

  eq(await vault.read(grantRow.ref), SENTINEL, "🔴🔴 the hook's signing secret is UNCHANGED — the cross-class redemption never reached the vault");
  eq((await store.getCredentialIntake(ORG, grant.id))!.usedAt, undefined, "…and the grant is NOT burned, so the legitimate holder still has their one shot");
  const stillWorks = await reveal.handleRevealPost(postReq(grant.token));
  eq(stillWorks.status, 200, "…proved: the reveal route still redeems the grant the attempt touched");
  ok((await stillWorks.text()).includes(SENTINEL), "…and hands over the ORIGINAL secret, not the submitted value");

  const genericIntake404 = await (await intakePage.handleIntakePageGet(new Request(`https://oe.example.test${intakePage.INTAKE_PAGE_PATH}?t=garbage`))).text();
  eq(await crossGet.text(), genericIntake404, "the wrong-class 404 is byte-identical to every other intake failure");

  const openGrant = await freshGrant();
  const named = await completeCredentialIntake({
    org: ORG,
    id: openGrant.id,
    value: ATTACKER_VALUE,
    submittedBy: USER,
    audit: { platform: "web", workspace: "intake-page", surface: "/connect/v1/intake" },
  });
  eq(named.ok, false, "the finalize seam refuses a reveal-grant row");
  eq(named.ok === false ? named.code : undefined, "wrong-class", "🔴 …with a NAMED reason — not collapsed into not-found");

  const clickGrant = await freshGrant();
  eq((await store.getCredentialIntake(ORG, clickGrant.id))!.usedAt, undefined, "fixture: the click's grant is open, so no other check can account for the refusal");
  const posted: string[] = [];
  const clickHandled = await handleSetKeyClick(
    {
      type: "block_actions",
      trigger_id: "TRIGGER",
      user: { id: USER },
      channel: { id: "C1" },
      actions: [{ action_id: `oe_setkey:${clickGrant.id}`, value: ORG }],
    },
    { post: async (method: string) => (posted.push(method), { ok: true }) },
  );
  ok(clickHandled, "the Slack click handler owns the click (it must never forward a half-understood payload)");
  ok(!posted.includes("views.open"), "🔴 …and opens NO modal for a REVEAL-class row — the grant's labels never reach a modal title");
  ok(posted.includes("chat.postEphemeral"), "…the clicker gets the same 'no longer available' notice as an unknown id");

  let minted = false;
  await assert.rejects(
    async () => {
      await createCredentialIntake({
        org: ORG,
        connector: reveal.REVEAL_GRANT_CONNECTOR,
        ref: "db:ope607-smuggled-key",
        requestedBy: USER,
        channelId: "C1",
        mintId: () => "ope607-smuggled",
      } as never);
      minted = true;
    },
    /reserved for grant rows/,
    "🔴 minting an intake row in the reserved grant class is refused",
  );
  n++;
  ok(!minted, "…the mint threw rather than returning");
  eq(await store.getCredentialIntake(ORG, "ope607-smuggled"), null, "…and wrote NO row");

  const goodRef = "db:ope607-real-key";
  const good = await createCredentialIntake({ org: ORG, connector: "notion", ref: goodRef, requestedBy: USER, channelId: "C1" });
  const goodToken = mintPageToken({ v: 1, aud: "intake", org: ORG, id: good.id, rb: USER, exp: Date.parse(good.expiresAt) }, KEY);
  eq(
    (await intakePage.handleIntakePageGet(new Request(`https://oe.example.test${intakePage.INTAKE_PAGE_PATH}?t=${encodeURIComponent(goodToken)}`))).status,
    200,
    "a REAL intake row still renders its form",
  );
  const goodPost = await intakePage.handleIntakePagePost(
    new Request(`https://oe.example.test${intakePage.INTAKE_PAGE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: goodToken, k: "FAKE-REAL-INTAKE-VALUE" }).toString(),
    }),
  );
  eq(goodPost.status, 200, "…and still stores through the page");
  ok((await store.getStoredCredential(ORG, goodRef)) !== null, "…the credential really landed in its home (the 200 is not the claim)");
  ok(typeof (await store.getCredentialIntake(ORG, good.id))!.usedAt === "string", "…and its row is spent, exactly as before");
}

await removeTempDir(dir);
console.log(`\n✅ webhook-reveal: ${n} checks passed`);
